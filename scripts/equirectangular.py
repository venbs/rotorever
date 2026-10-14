"""Deterministic spherical sampling; no generation or browser dependencies."""
import math

import numpy as np


def sun_direction(uv, heading_degrees=0):
    if len(uv) != 2 or not all(math.isfinite(v) for v in uv):
        raise ValueError("sunUV must contain two finite coordinates")
    u, v = uv
    if not 0 <= u <= 1 or not 0 < v < .5:
        raise ValueError("sunUV must locate a sun above the horizon")
    longitude = (u - .5) * 2 * math.pi - math.radians(heading_degrees)
    latitude = (.5 - v) * math.pi
    return [math.cos(latitude) * math.cos(longitude), math.sin(latitude),
            math.cos(latitude) * math.sin(longitude)]


def close_spherical_edges(rgb, seam_degrees, pole_degrees):
    """Feather only a narrow rear seam and polar caps, leaving the front intact.

    This removes colour discontinuities, not mismatched scene geometry. Reject
    or regenerate a source with doubled objects or a broken horizon at the seam.
    """
    image = np.array(rgb, dtype=np.float32, copy=True)
    height, width = image.shape[:2]
    if not 0 <= seam_degrees <= 10 or not 0 <= pole_degrees <= 5:
        raise ValueError("Use narrow edge correction: seam 0–10°, poles 0–5°")
    band = round(width * seam_degrees / 360)
    if band >= 2:
        target = (image[:, 0] + image[:, -1]) * .5
        weight = np.linspace(1, 0, band)
        weight = (weight * weight * (3 - 2 * weight))[None, :, None]
        image[:, :band] += (target[:, None] - image[:, :band]) * weight
        image[:, -band:] += (target[:, None] - image[:, -band:]) * weight[:, ::-1]
    cap = round(height * pole_degrees / 180)
    if cap >= 2:
        weight = np.linspace(1, 0, cap)
        weight = (weight * weight * (3 - 2 * weight))[:, None, None]
        image[:cap] += (image[0].mean(axis=0) - image[:cap]) * weight
        image[-cap:] += (image[-1].mean(axis=0) - image[-cap:]) * weight[::-1]
    return np.uint8(np.clip(np.rint(image), 0, 255))


class Equirectangular:
    def __init__(self, rgb, heading_degrees=0):
        if rgb.ndim != 3 or rgb.shape[2] != 3 or rgb.shape[1] != 2 * rgb.shape[0]:
            raise ValueError("Expected an RGB 2:1 equirectangular panorama")
        if not math.isfinite(heading_degrees):
            raise ValueError("headingDegrees must be finite")
        self.image = rgb
        self.heading = math.radians(heading_degrees)

    def render(self, rays):
        # Chunk to bound peak memory when producing a 2048² face.
        result = np.empty((*rays.shape[:-1], 3), dtype=np.uint8)
        height, width = self.image.shape[:2]
        for start in range(0, len(rays), 128):
            direction = rays[start:start + 128]
            direction = direction / np.linalg.norm(direction, axis=-1, keepdims=True)
            longitude = np.arctan2(direction[..., 2], direction[..., 0]) + self.heading
            latitude = np.arcsin(np.clip(direction[..., 1], -1, 1))
            x = ((longitude / (2 * np.pi) + .5) % 1) * width - .5
            y = np.clip((.5 - latitude / np.pi) * height - .5, 0, height - 1)
            x0, y0 = np.floor(x).astype(int), np.floor(y).astype(int)
            wx, wy = (x - x0)[..., None], (y - y0)[..., None]
            top = self.image[y0, x0 % width] * (1 - wx) + self.image[y0, (x0 + 1) % width] * wx
            bottom = self.image[np.minimum(y0 + 1, height - 1), x0 % width] * (1 - wx) + self.image[np.minimum(y0 + 1, height - 1), (x0 + 1) % width] * wx
            result[start:start + 128] = np.clip(np.rint(top * (1 - wy) + bottom * wy), 0, 255)
        return result
