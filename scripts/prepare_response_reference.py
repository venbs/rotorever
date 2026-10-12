"""Extract user-owned recording observations for reproducible response fitting."""
from pathlib import Path
import argparse
import json
import numpy as np
from helix_recording import read_recording
from analyze_helix import arrays, body_rate_intervals
from analyze_personal_recording import projected_acceleration, point_mask


def prepare(source):
    r, rotation, t = arrays(read_recording(source))
    dt = np.diff(t)
    position, velocity, controls = r[3][:, :3], r[4][:, :3], r[5][:, :4]
    body = np.einsum('nji,nj->ni', rotation, velocity)
    observed = projected_acceleration(velocity, rotation, t)
    omega, angle = body_rate_intervals(rotation, t)
    residual = np.linalg.norm(np.diff(position, axis=0) / dt[:, None] - (velocity[1:] + velocity[:-1]) / 2, axis=1)
    intervals = (residual < 1) & (angle < 1.57) & (position[:-1, 1] > 2) & (position[1:, 1] > 2) & (dt > .01) & (dt < .05)
    # Fixed split/end for this audited 96.6 s recording, not auto-selected to
    # improve fit. Last reset at 94.54 s is excluded before differentiation use.
    airborne = point_mask(intervals) & (t > 1) & (t < 94)
    low = airborne & (np.linalg.norm(body[:, [0, 2]], axis=1) < 4) & (abs(body[:, 1]) < 6)
    return {'samples': [{'t': float(time), 'collective': float(u), 'bodyVelocity': v.tolist()} for time, u, v in zip(t, controls[:, 0], body)],
            'observed': observed.tolist(), 'train': (low & (t < 48)).tolist(), 'heldOut': (low & (t >= 48)).tolist(),
            'freeFlight': airborne.tolist(), 'position': position.tolist(), 'velocity': velocity.tolist(),
            'controls': controls.tolist(), 'omega': omega.tolist(), 'rotation': rotation.tolist()}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--file', type=Path, required=True)
    parser.add_argument('--out', type=Path, default=Path('analysis/response-calibration/reference.json'))
    args = parser.parse_args()
    result = prepare(args.file)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, allow_nan=False) + '\n')
    print(f"{len(result['samples'])} frames; train={sum(result['train'])}, heldOut={sum(result['heldOut'])}")
