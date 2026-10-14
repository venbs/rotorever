#!/usr/bin/env python3
"""Import a generated 2:1 panorama into the existing lightweight photo-field format.

Image creation is a separate, reviewed step. This importer makes no network
requests, pins the source by SHA-256, and records native resolution honestly.
"""
import argparse
import json
import math
import re
from pathlib import Path

import numpy as np
from PIL import Image, features

from equirectangular import Equirectangular, close_spherical_edges, sun_direction
from map_assets import export_cubemap, sha256

ROOT = Path(__file__).resolve().parents[1]


def prepare(config, source):
    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", config["id"]):
        raise ValueError("Map id must be a lowercase kebab-case directory name")
    if sha256(source) != config["sourceSha256"]:
        raise ValueError("Source SHA-256 changed; review the source and recalibrate before importing")
    for key in ("eyeHeight", "startDistance"):
        if not math.isfinite(config[key]) or config[key] <= 0:
            raise ValueError(f"{key} must be positive and finite")
    with Image.open(source) as original:
        if original.width != original.height * 2:
            raise ValueError("Source must be a full 360° × 180° panorama with a 2:1 ratio")
        if original.width < 1024:
            raise ValueError("Source too small even for a draft map")
        rgb = np.asarray(original.convert("RGB"))
    calibration = config["calibration"]
    heading = calibration["headingDegrees"]
    sampler = Equirectangular(rgb, heading)  # Validate heading before processing.
    sun = sun_direction(calibration["sunUV"], heading)
    corrected = close_spherical_edges(rgb, calibration["seamBlendDegrees"], calibration["poleBlendDegrees"])
    sampler.image = corrected
    edge_error = lambda image: float(np.abs(image[:, 0].astype(float) - image[:, -1]).mean())
    manifest = {
        "version": 1,
        "field": {
            "id": config["id"], "name": config["name"], "groundY": 0,
            "pilot": {"x": -config["startDistance"], "y": config["eyeHeight"], "z": 0},
            "lightRay": dict(zip(("x", "y", "z"), [-v for v in sun])),
            "backgroundYaw": 0, "lighting": config["lighting"],
        },
        "source": {
            "file": source.name, "size": [rgb.shape[1], rgb.shape[0]],
            "bytes": source.stat().st_size, "sha256": sha256(source),
            "kind": "generated", "generation": config["generation"],
        },
        "processing": {
            "projection": "equirectangular to Three.js image cubemap",
            "colorSpace": "sRGB", "generateMipmaps": False,
            "sampling": "bilinear; periodic longitude; clamped poles",
            "encoder": {"pillow": Image.__version__, "webp": features.version("webp")},
            "calibration": {
                **calibration, "sunDirection": sun,
                "sunElevationDegrees": math.degrees(math.asin(sun[1])),
                "sunAzimuthDegrees": math.degrees(math.atan2(sun[2], sun[0])),
            },
            "quality": {
                "sourcePixelsPerDegree": rgb.shape[1] / 360,
                "sourcePixelsPer90Degrees": rgb.shape[1] / 4,
                "standardFacesUpsampled": rgb.shape[1] < 8192,
                "note": "2048px output faces preserve the project format, not 2048px of native angular detail. No AI super-resolution was applied.",
                "seamMeanAbsoluteErrorBefore": edge_error(rgb),
                "seamMeanAbsoluteErrorAfter": edge_error(corrected),
            },
        },
    }
    return manifest, sampler, corrected


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=ROOT / "scripts/maps/river-meadow.json")
    parser.add_argument("--output", type=Path, help="Default: public/environments/<id>")
    parser.add_argument("--review", type=Path, help="Optional corrected panorama PNG outside public/")
    args = parser.parse_args()
    config = json.loads(args.config.read_text())
    source = ROOT / config["source"]
    prompt = ROOT / config["generation"]["promptFile"]
    if sha256(prompt) != config["generation"]["promptSha256"]:
        raise ValueError("Prompt differs from generation record; preserve the original prompt")
    manifest, sampler, corrected = prepare(config, source)
    output = args.output or ROOT / "public/environments" / config["id"]
    quality = manifest["processing"]["quality"]
    if quality["standardFacesUpsampled"]:
        print(f"Source: {manifest['source']['size']}; {quality['sourcePixelsPer90Degrees']:g} native pixels per 90°. Output size does not add source detail.", flush=True)
    export_cubemap(output, manifest, sampler.render)
    if args.review:
        args.review.parent.mkdir(parents=True, exist_ok=True)
        Image.fromarray(corrected).save(args.review)
    print(f"Map written to {output}", flush=True)


if __name__ == "__main__":
    main()
