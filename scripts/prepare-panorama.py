#!/usr/bin/env python3
"""Offline X5 DNG -> calibrated, leveled, sRGB WebP cubemap.

Only the 12 WebP tiles and manifest are shipped. RAW development and geometric
stitching never run in the browser. Calibration belongs to this capture: do not
silently reuse it on another photograph. For a new capture create a new config.

Projection: unified omnidirectional (MEI), followed by the DNG's three radial and
two tangential terms. No invented image content or 3D scene reconstruction.
"""
import argparse
import json
import struct
import subprocess
from pathlib import Path

import cv2
import numpy as np
import rawpy
from PIL import Image

from map_assets import FACES, export_cubemap, sha256

ROOT = Path(__file__).resolve().parents[1]


def read_gain_maps(path):
    """Read the standard DNG OpcodeList2 without decoding the full TIFF twice."""
    with path.open("rb") as handle:
        header = handle.read(8)
        if header[:4] != b"II*\x00":
            raise ValueError("Expected the X5's little-endian TIFF DNG")
        handle.seek(struct.unpack_from("<I", header, 4)[0])
        count = struct.unpack("<H", handle.read(2))[0]
        entries = [struct.unpack("<HHII", handle.read(12)) for _ in range(count)]
        entry = next((e for e in entries if e[0] == 51009), None)
        if entry is None:
            raise ValueError("DNG has no lens shading maps")
        _, kind, size, offset = entry
        if kind != 7 or size > 16_000_000:
            raise ValueError("Unexpected DNG opcode format")
        handle.seek(offset)
        data = handle.read(size)
    count = struct.unpack_from(">I", data)[0]
    position = 4
    maps = []
    for _ in range(count):
        opcode, _, _, size = struct.unpack_from(">4I", data, position)
        position += 16
        payload = data[position:position + size]
        position += size
        if opcode != 9 or len(payload) < 76:
            raise ValueError("Unsupported DNG opcode; export through Insta360 Studio")
        area = struct.unpack_from(">8I", payload)
        rows, cols = struct.unpack_from(">2I", payload, 32)
        spacing = struct.unpack_from(">4d", payload, 40)
        planes = struct.unpack_from(">I", payload, 72)[0]
        if planes != 1 or len(payload) != 76 + rows * cols * 4:
            raise ValueError("Unexpected gain map layout")
        grid = np.frombuffer(payload, dtype=">f4", offset=76).reshape(rows, cols).astype(np.float32)
        maps.append((area, spacing, grid))
    return maps


def develop(path):
    """Apply per-CFA lens shading, then LibRaw WB, highlights and RGB conversion."""
    maps = read_gain_maps(path)
    with rawpy.imread(str(path)) as raw:
        sensor = raw.raw_image
        height, width = sensor.shape
        if raw.color_desc != b"RGBG" or raw.black_level_per_channel != [4096] * 4:
            raise ValueError("This RAW development profile expects the supplied X5 capture")
        for area, spacing, grid in maps:
            top, left, bottom, right, _, _, row_pitch, col_pitch = area
            step_y, step_x, origin_y, origin_x = spacing
            # Firmware v1.7.43 stores bottom=5967 for a 5952-row sensor. Core
            # Image rejects that map; clamp to actual bounds before applying it.
            bottom, right = min(bottom, height), min(right + 1, width)
            rows = np.arange(top, bottom, row_pitch)
            cols = np.arange(left, right, col_pitch)
            mx = np.broadcast_to(((cols + .5) / width - origin_x) / step_x,
                                 (len(rows), len(cols))).astype(np.float32)
            my = np.broadcast_to((((rows + .5) / height - origin_y) / step_y)[:, None],
                                 mx.shape).astype(np.float32)
            gain = cv2.remap(grid, mx, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
            pixels = sensor[top:bottom:row_pitch, left:right:col_pitch]
            pixels[:] = np.clip((pixels.astype(np.float32) - 4096) * gain + 4096,
                                0, raw.white_level).astype(np.uint16)
        # Preserve the full sensor resolution before geometric reprojection.
        # Half-size Bayer development visibly softens grass at the default FOV.
        rgb = raw.postprocess(half_size=False, use_camera_wb=True, no_auto_bright=False,
                              bright=1.5, highlight_mode=rawpy.HighlightMode.Blend,
                              gamma=(2.4, 12.92), output_bps=8)
    return rgb, (width, height)


def read_lenses(path):
    comment = subprocess.check_output(["exiftool", "-s3", "-UserComment", str(path)], text=True).strip()
    if not comment.startswith("INSTA3602_"):
        raise ValueError("Expected Insta360 dual-lens calibration in UserComment")
    values = [float(value) for value in comment.split(" ")[0].split("_")[1:]]
    # Each 19-value record: xi, fx, fy, cx, cy, 3 rotation, 3 translation,
    # k1,k2,k3,p1,p2, calibration width,height, model type.
    if len(values) < 38:
        raise ValueError("Incomplete lens calibration")
    return [values[:19], values[19:38]]


def equirect_rays(width):
    height = width // 2
    longitude = (np.arange(width) + .5) / width * 2 * np.pi - np.pi
    latitude = np.pi / 2 - (np.arange(height) + .5) / height * np.pi
    return np.stack((np.cos(latitude)[:, None] * np.cos(longitude)[None, :],
                     np.broadcast_to(np.sin(latitude)[:, None], (height, width)),
                     np.cos(latitude)[:, None] * np.sin(longitude)[None, :]), axis=-1)


class Stitcher:
    def __init__(self, image, lenses, calibration):
        self.image, self.lenses, self.calibration = image, lenses, calibration
        self.relative_rotation = cv2.Rodrigues(np.array(calibration["secondLensRotationVector"]))[0]
        self.level = np.array(calibration["worldToCapture"])
        if not np.allclose(self.level.T @ self.level, np.eye(3), atol=1e-7):
            raise ValueError("World-to-capture transform must be orthonormal")

    def render(self, rays):
        capture = rays @ self.level.T
        colors = []
        for index, lens in enumerate(self.lenses):
            direction = capture if index == 0 else capture @ self.relative_rotation
            xi, fx, fy, cx, cy = lens[:5]
            k1, k2, k3, p1, p2 = lens[11:16]
            sign = -1 if index == 0 else 1
            x = sign * direction[..., 2] / (sign * direction[..., 0] + xi)
            y = -direction[..., 1] / (sign * direction[..., 0] + xi)
            r2 = x * x + y * y
            radial = 1 + k1 * r2 + k2 * r2 ** 2 + k3 * r2 ** 3
            scale = self.image.shape[1] / lens[16]
            focal = self.calibration["focalScale"][index]
            u = (focal * fx * (x * radial + 2 * p1 * x * y + p2 * (r2 + 2 * x * x)) + cx) * scale
            v = (focal * fy * (y * radial + p1 * (r2 + 2 * y * y) + 2 * p2 * x * y) + cy) * scale
            colors.append(cv2.remap(self.image, u.astype(np.float32), v.astype(np.float32), cv2.INTER_LINEAR))
        # A narrow smooth overlap avoids averaging distant surfaces over wide
        # bands. Nearby hands/rotor blades still have unavoidable lens parallax.
        weight = np.clip((capture[..., 0] + .07) / .14, 0, 1)[..., None]
        weight = weight * weight * (3 - 2 * weight)
        return np.uint8(np.clip(colors[0] * (1 - weight) + colors[1] * weight, 0, 255))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=ROOT / "scripts/maps/x5-grassland.json")
    parser.add_argument("--source", type=Path, help="Override the original's location")
    parser.add_argument("--output", type=Path, help="Default: public/environments/<id>")
    parser.add_argument("--review", type=Path, help="Optional offline equirectangular preview (not deployed)")
    args = parser.parse_args()
    config = json.loads(args.config.read_text())
    source = args.source or ROOT / config["source"]
    output = args.output or ROOT / "public/environments" / config["id"]
    digest = sha256(source)
    if config.get("sourceSha256") and digest != config["sourceSha256"]:
        raise ValueError("The capture differs from the calibrated source; use its own calibration")
    print("Developing RAW and correcting lens shading…", flush=True)
    rgb, dimensions = develop(source)
    lenses = read_lenses(source)
    stitcher = Stitcher(rgb, lenses, config["calibration"])
    manifest = {
        "version": 1,
        "field": {
            "id": config["id"], "name": config["name"], "groundY": 0,
            "pilot": {"x": -config["startDistance"], "y": config["eyeHeight"], "z": 0},
            "lightRay": dict(zip(("x", "y", "z"), (-np.array(config["calibration"]["sunDirection"])).tolist())),
            "backgroundYaw": 0, "lighting": config["lighting"],
        },
        "source": {"file": source.name, "camera": "Insta360 X5", "capture": config["capture"],
                   "bytes": source.stat().st_size, "size": dimensions, "sha256": digest,
                   "ownership": "User-supplied original field photograph"},
        "processing": {"projection": "dual-fisheye MEI to Three.js image cubemap",
                       "gainMaps": 8, "colorSpace": "sRGB", "generateMipmaps": False,
                       "calibration": config["calibration"]},
        "cubeOrder": FACES, "tiers": {},
    }
    export_cubemap(output, manifest, stitcher.render)
    if args.review:
        args.review.parent.mkdir(parents=True, exist_ok=True)
        Image.fromarray(stitcher.render(equirect_rays(2400))).save(args.review, quality=93)
    print(f"Map written to {output}", flush=True)


if __name__ == "__main__":
    main()
