"""Audit recordings, estimate behavioral summaries, and write aggregate JSON.

Requires numpy. Reads the user's HELI-X install; never writes to it. No raw
recordings, proprietary model tables, or decompiled code are exported.
"""
from pathlib import Path
import argparse
import hashlib
import json
import numpy as np
from helix_recording import read_recording, metadata


def quantiles(values):
    return dict(zip(("min", "p50", "p95", "max"), map(float, np.percentile(values, [0, 50, 95, 100]))))


def arrays(recording):
    r = [np.array([frame[i] for frame in recording.rows]) for i in range(8)]
    return r, np.stack(r[:3], axis=1), r[7][:, 0] * 1e-6


def body_rate_intervals(rotation, time):
    """SO(3) log of R[i]^T R[i+1], interval-averaged rad/s, body axes at i."""
    relative = rotation[:-1].transpose(0, 2, 1) @ rotation[1:]
    angle = np.arccos(np.clip((np.trace(relative, axis1=1, axis2=2) - 1) / 2, -1, 1))
    factor = np.full(len(angle), 0.5)
    moving = angle > 1e-5
    factor[moving] = angle[moving] / (2 * np.sin(angle[moving]))
    skew = np.stack((relative[:, 2, 1] - relative[:, 1, 2],
                     relative[:, 0, 2] - relative[:, 2, 0],
                     relative[:, 1, 0] - relative[:, 0, 1]), axis=1)
    return skew * (factor / np.diff(time))[:, None], angle


def audit(path, root):
    recording = read_recording(path)
    r, rotation, t = arrays(recording)
    dt = np.diff(t)
    delta_p = np.diff(r[3][:, :3], axis=0)
    v_mid = (r[4][1:, :3] + r[4][:-1, :3]) / 2
    derivative = delta_p / dt[:, None]
    residual = np.linalg.norm(derivative - v_mid, axis=1)
    denominator = np.sum(v_mid * v_mid)
    scale = float(np.sum(derivative * v_mid) / denominator) if denominator else None
    orthogonal = rotation @ rotation.transpose(0, 2, 1) - np.eye(3)
    determinants = np.linalg.det(rotation)
    w, angle = body_rate_intervals(rotation, t)
    info = metadata(path)
    result = {"file": path.relative_to(root).as_posix(), **info,
              "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
              "schema": recording.schema, "frames": recording.frames,
              "durationSeconds": float(t[-1] - t[0]), "sampleIntervalMs": quantiles(dt * 1000),
              "orthogonalityMaxError": float(np.max(np.abs(orthogonal))),
              "determinantRange": [float(determinants.min()), float(determinants.max())],
              "positionVelocityScale": scale,
              "positionVelocityResidualMps": quantiles(residual),
              "intervalRotationDeg": quantiles(np.degrees(angle)),
              "controlRange": [[float(v.min()), float(v.max())] for v in r[5][:, :4].T],
              "suspectIntervals": int(np.sum((residual > 1) | (dt > .06) | (angle > np.pi / 2)))}
    # Free-flight, complete intervals with moderate rotation and valid kinematics.
    good = (dt > .01) & (dt < .05) & (residual < 1) & (angle < np.pi / 2) & (r[3][:-1, 1] > 2) & (r[3][1:, 1] > 2)
    if info["model"] and info["model"].startswith("helicopter/") and path.parent.parent.name == "Demos":
        result["rateFits"] = rate_fits(r[5][:, :4], w, t, good)
        result["collectiveFits"] = collective_fits(r, rotation, t, good)
    return result


def rate_fits(controls, omega, t, good):
    """Descriptive fits, NOT an open-loop latency/system-identification claim.

    A 30 ms grid deliberately avoids reporting spurious sub-frame precision.
    Negative candidate lags are included to reveal timestamp/alignment bias.
    """
    midpoint = (t[:-1] + t[1:]) / 2
    result = {}
    for label, axis, channel, sign in [("roll", 0, 2, 1), ("pitch", 2, 1, -1), ("yaw", 1, 3, 1)]:
        y = np.degrees(omega[:, axis]) * sign
        # Same observations for every lag; first/last 120ms excluded.
        valid = good & (midpoint > t[0] + .12) & (midpoint < t[-1] - .12)
        scores = []
        for delay in [-.06, -.03, 0, .03, .06, .09]:
            u = np.interp(midpoint - delay, t, controls[:, channel])
            x = np.column_stack((u, u ** 3))
            coef = np.linalg.lstsq(x[valid], y[valid], rcond=None)[0]
            error = y[valid] - x[valid] @ coef
            scores.append({"lagMs": int(round(delay * 1000)), "rmsDegPerSecond": float(np.sqrt(np.mean(error ** 2))),
                           "linear": float(coef[0]), "cubic": float(coef[1])})
        best = min(scores, key=lambda s: s["rmsDegPerSecond"])
        result[label] = {"samples": int(valid.sum()), "bestGridLagMs": best["lagMs"],
                         "bestFitFullStickRate": best["linear"] + best["cubic"], "scores": scores,
                         "warning": "Closed-loop demonstration, unknown rates/expo and recorder phase. Zero grid lag does not mean zero latency."}
    return result


def collective_fits(r, rotation, t, interval_good):
    # Differentiate recorded WORLD velocity with nonuniform time weights. Add
    # back world gravity, then project onto recorded body-up. This includes
    # all non-gravity forces: it is NOT an isolated main-rotor thrust sensor.
    acceleration = np.gradient(r[4][:, :3], t, axis=0)
    acceleration[:, 1] += 9.80665
    normal = np.einsum("ni,ni->n", acceleration, rotation[:, :, 1])
    body_velocity = np.einsum("nji,nj->ni", rotation, r[4][:, :3])
    collective = r[5][:, 0]
    good = np.zeros(len(t), dtype=bool)
    good[1:-1] = interval_good[:-1] & interval_good[1:]
    good &= (np.linalg.norm(body_velocity[:, [0, 2]], axis=1) < 4) & (abs(body_velocity[:, 1]) < 6)
    masks = {"lowRecordedSpeed": good,
             "alignedFlow": good & (body_velocity[:, 1] * collective >= 0) & (abs(collective) > .05) & (abs(collective) < .7)}
    x = np.column_stack((np.ones(len(t)), collective, body_velocity[:, 1]))
    fits = {}
    for name, mask in masks.items():
        if mask.sum() < 50 or np.linalg.matrix_rank(x[mask]) < 3:
            fits[name] = {"samples": int(mask.sum()), "usable": False}
            continue
        coef = np.linalg.lstsq(x[mask], normal[mask], rcond=None)[0]
        error = normal[mask] - x[mask] @ coef
        # Sign-separated and first/second-half fits expose maneuver imbalance.
        splits = []
        for label, sub in [("positive", collective > 0), ("negative", collective < 0),
                           ("firstHalf", t < (t[0] + t[-1]) / 2), ("secondHalf", t >= (t[0] + t[-1]) / 2)]:
            sub &= mask
            if sub.sum() >= 30 and np.linalg.matrix_rank(x[sub]) == 3:
                c = np.linalg.lstsq(x[sub], normal[sub], rcond=None)[0]
                splits.append({"group": label, "samples": int(sub.sum()), "collectiveGain": float(c[1])})
        fits[name] = {"samples": int(mask.sum()), "usable": True, "offset": float(coef[0]),
                      "collectiveGain": float(coef[1]), "axialVelocityGain": float(coef[2]),
                      "rmsAcceleration": float(np.sqrt(np.mean(error ** 2))),
                      "collectiveRange": [float(collective[mask].min()), float(collective[mask].max())], "splits": splits}
    if r[5].shape[1] >= 5:
        # Recorded scalar A correlates with collective. Its absolute physical
        # interpretation is not needed for normalized-stick fits above.
        coef = np.polyfit(collective, r[5][:, 4], 1)
        fits["recordedPitchCandidate"] = {"slope": float(coef[0]), "offset": float(coef[1]),
                                          "correlation": float(np.corrcoef(collective, r[5][:, 4])[0, 1])}
    return fits


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path("/Applications/HELI-X11.app/Contents/resources/flights"))
    parser.add_argument("--out", type=Path, default=Path("analysis/helix-recordings.json"))
    args = parser.parse_args()
    paths = sorted(args.root.rglob("*.fly"))
    if not paths:
        raise SystemExit(f"No .fly recordings under {args.root}")
    results, failures = [], []
    for path in paths:
        try:
            results.append(audit(path, args.root))
        except (ValueError, OSError) as exc:
            failures.append({"file": path.relative_to(args.root).as_posix(), "error": str(exc)})
    report = {"sourceRoot": str(args.root), "filesFound": len(paths), "filesParsed": len(results),
              "frames": sum(r["frames"] for r in results), "failures": failures,
              "fieldMap": {"rows1to3": "row-major body-to-world rotation matrix",
                           "row4Columns1to3": "world position, metres",
                           "row5Columns1to3": "world velocity, metres/second",
                           "row6Columns1to4": "normalized collective, pitch/nick, roll, yaw; recorded controller outputs, not USB packets",
                           "row8": "integer microseconds; checked against position/velocity kinematics",
                           "remainingFields": "Preserved by parser; NOT assumed to be rates/RPM/torque"},
              "limits": ["Historical demonstrations; not controlled steps or current HELI-X 11 live validation.",
                         "About 30 ms recording intervals cannot resolve millisecond input/controller delays.",
                         "Recordings do not capture the complete original tune, wind, model revision or internal state.",
                         "Closed-loop correlations and force regressions are descriptive, not causal parameter estimates.",
                         "No matching 550 recording found in supplied metadata; cross-size 550/700 calibration remains open."],
              "recordings": results}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + "\n")
    print(f"Parsed {len(results)}/{len(paths)} recordings, {report['frames']} frames; failures={len(failures)}")
    for r in results:
        if "collectiveFits" in r:
            print(r["file"], json.dumps(r["collectiveFits"]["alignedFlow"], ensure_ascii=False))
    if failures:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
