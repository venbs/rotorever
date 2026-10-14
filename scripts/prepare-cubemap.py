#!/usr/bin/env python3
"""Import six user-refined faces directly, preserving their projection and detail.

No intermediate panorama and no seam blur. Source files are SHA-pinned; preview
and standard faces use the shared project encoding contract.
"""
import argparse
import io
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageCms, ImageOps, features

from map_assets import FACES, cube_rays, export_cubemap, sha256

ROOT = Path(__file__).resolve().parents[1]
INPUT_FACES = {"forward": "left", "right": "front", "rear": "right",
               "left": "back", "up": "top", "down": "bottom"}


def face_basis(face):
    grid = cube_rays(face, 3)
    centre = grid[1, 1]
    right = (grid[1, 2] / np.dot(grid[1, 2], centre) - centre) * 1.5
    down = (grid[2, 1] / np.dot(grid[2, 1], centre) - centre) * 1.5
    return centre, right, down


def direction_from_face(face, uv):
    if len(uv) != 2 or not all(math.isfinite(v) and 0 <= v <= 1 for v in uv):
        raise ValueError("sunUV must contain two normalized finite coordinates")
    centre, right, down = face_basis(face)
    ray = centre + (2 * uv[0] - 1) * right + (2 * uv[1] - 1) * down
    return ray / np.linalg.norm(ray)


def load_sources(config, root=ROOT):
    if set(config["sources"]) != set(INPUT_FACES):
        raise ValueError("Expected exactly forward, right, rear, left, up, down")
    images, records = {}, []
    for direction, face in INPUT_FACES.items():
        entry = config["sources"][direction]
        path = root / entry["file"]
        digest = sha256(path)
        if digest != entry["sha256"]:
            raise ValueError(f"Source SHA-256 changed: {path}; review before importing")
        with Image.open(path) as original:
            picture = ImageOps.exif_transpose(original)
            profile = original.info.get("icc_profile")
            if profile:
                picture = ImageCms.profileToProfile(picture, ImageCms.ImageCmsProfile(io.BytesIO(profile)),
                                                   ImageCms.createProfile("sRGB"), outputMode="RGB")
            else:
                picture = picture.convert("RGB")
            if picture.width != picture.height or picture.width < 2048:
                raise ValueError(f"HD faces must be square and at least 2048px: {path}")
            images[face] = picture.copy()
            records.append({"file": entry["file"], "direction": direction, "projectFace": face,
                            "size": list(picture.size), "bytes": path.stat().st_size,
                            "sha256": digest, "colorProfile": "converted to sRGB" if profile else "assumed sRGB"})
    if len({image.size for image in images.values()}) != 1:
        raise ValueError("All six source faces must have the same dimensions")
    return images, records


def assess_edges(images):
    """Match all 12 cube edges in world space, accounting for edge reversal.

    RGB differences are diagnostics, not proof of geometric or visual continuity.
    Downsample before measuring so individual grass blades do not dominate.
    """
    t = np.linspace(-1, 1, 65)
    edges = []
    for face in FACES:
        centre, right, down = face_basis(face)
        rgb = np.asarray(images[face].resize((512, 512), Image.Resampling.LANCZOS)).astype(float)
        for edge, u, v, pixels in (
            ("left", -np.ones_like(t), t, rgb[:, :2].mean(axis=1)),
            ("right", np.ones_like(t), t, rgb[:, -2:].mean(axis=1)),
            ("top", t, -np.ones_like(t), rgb[:2].mean(axis=0)),
            ("bottom", t, np.ones_like(t), rgb[-2:].mean(axis=0)),
        ):
            rays = centre + u[:, None] * right + v[:, None] * down
            rays /= np.linalg.norm(rays, axis=-1, keepdims=True)
            edges.append((face, edge, rays, pixels))
    records, used = [], set()
    for i, (face, edge, rays, pixels) in enumerate(edges):
        if i in used:
            continue
        for j, (other_face, other_edge, other_rays, other_pixels) in enumerate(edges):
            if j == i or j in used or other_face == face:
                continue
            reverse = np.allclose(rays, other_rays[::-1], atol=1e-10)
            if reverse or np.allclose(rays, other_rays, atol=1e-10):
                other_pixels = other_pixels[::-1] if reverse else other_pixels
                records.append({"a": f"{face}:{edge}", "b": f"{other_face}:{other_edge}",
                                "reverse": bool(reverse),
                                "meanAbsoluteRGBDifference": round(float(np.abs(pixels - other_pixels).mean()), 3),
                                "meanRGBOffset": np.round((pixels - other_pixels).mean(axis=0), 3).tolist()})
                used.update((i, j))
                break
        else:
            raise ValueError(f"No matching cube edge for {face}:{edge}")
    if len(records) != 12:
        raise ValueError("Expected twelve cube edges")
    return sorted(records, key=lambda record: record["meanAbsoluteRGBDifference"], reverse=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=ROOT / "scripts/maps/river-meadow-hd.json")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    config = json.loads(args.config.read_text())
    if not config["id"] or any(c not in "abcdefghijklmnopqrstuvwxyz0123456789-" for c in config["id"]):
        raise ValueError("Invalid map id")
    for key in ("eyeHeight", "startDistance"):
        if not math.isfinite(config[key]) or config[key] <= 0:
            raise ValueError(f"{key} must be positive and finite")
    images, records = load_sources(config)
    calibration = config["calibration"]
    sun = direction_from_face(calibration["sunFace"], calibration["sunUV"])
    if sun[1] <= 0:
        raise ValueError("The sun must be above the horizon")
    manifest = {
        "version": 1,
        "field": {"id": config["id"], "name": config["name"], "groundY": 0,
                  "pilot": {"x": -config["startDistance"], "y": config["eyeHeight"], "z": 0},
                  "lightRay": dict(zip(("x", "y", "z"), (-sun).tolist())),
                  "backgroundYaw": 0, "lighting": config["lighting"]},
        "source": {"kind": "user-refined-cubemap", "files": records,
                   "bytes": sum(record["bytes"] for record in records),
                   "provenance": config["provenance"]},
        "processing": {
            "projection": "direct six-face cubemap; no equirectangular intermediate",
            "colorSpace": "sRGB", "generateMipmaps": False,
            "resize": "Lanczos downsample only", "seamTreatment": "none; import test",
            "encoder": {"pillow": Image.__version__, "webp": features.version("webp")},
            "calibration": {**calibration, "sunDirection": sun.tolist(),
                            "sunElevationDegrees": math.degrees(math.asin(sun[1])),
                            "sunAzimuthDegrees": math.degrees(math.atan2(sun[2], sun[0]))},
            "seamAssessment": {"status": "needs visual review / edge alignment",
                               "metric": "Mean absolute sRGB difference, 512px faces, two-pixel edge bands; not a geometric error measure.",
                               "edges": assess_edges(images)},
        },
    }
    output = args.output or ROOT / "public/environments" / config["id"]
    export_cubemap(output, manifest, face_images=images)
    print(f"Imported {len(images)} faces from {images['left'].width}px sources into {output}")
    print("Seam pixels preserved; per-edge diagnostics are in manifest.json")


if __name__ == "__main__":
    main()
