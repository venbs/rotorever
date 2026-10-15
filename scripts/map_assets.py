"""Shared offline map contract: Three.js image-cubemap orientation and encoding."""
import hashlib
import json

import numpy as np
from PIL import Image, ImageOps

FACES = ("right", "left", "top", "bottom", "front", "back")
TIERS = (("preview", 256, 72), ("standard", 2048, 92))


def sha256(path):
    with path.open("rb") as handle:
        digest = hashlib.sha256()
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
        return digest.hexdigest()


def cube_rays(face, size):
    """Texel-center world directions, including Three's image-cubemap X flip."""
    u, v = np.meshgrid((np.arange(size) + .5) / size * 2 - 1,
                       (np.arange(size) + .5) / size * 2 - 1)
    one = np.ones_like(u)
    directions = {
        "right": (-one, -v, -u), "left": (one, -v, u),
        "top": (-u, one, v), "bottom": (-u, -one, -v),
        "front": (-u, -v, one), "back": (u, -v, -one),
    }
    rays = np.stack(directions[face], axis=-1)
    return rays / np.linalg.norm(rays, axis=-1, keepdims=True)


def export_thumbnail(output, manifest):
    """A separate small card image; left is the initial +X view in our cube frame."""
    destination = output / "thumbnail.webp"
    temporary = destination.with_suffix(".webp.tmp")
    with Image.open(output / "standard/left.webp") as source:
        picture = ImageOps.fit(source, (640, 400), method=Image.Resampling.LANCZOS)
        picture.save(temporary, "WEBP", quality=82, method=6)
    temporary.replace(destination)
    manifest["thumbnail"] = {"file": destination.name, "width": 640, "height": 400,
                             "bytes": destination.stat().st_size, "sha256": sha256(destination)}


def export_cubemap(output, manifest, render=None, *, face_images=None):
    """Camera and generated maps share twelve cube WebPs, a thumbnail and manifest."""
    if (render is None) == (face_images is None):
        raise ValueError("Provide either a ray renderer or six face images")
    if face_images is not None and set(face_images) != set(FACES):
        raise ValueError("Expected exactly the six project cubemap faces")
    manifest.update(cubeOrder=FACES, tiers={})
    for tier, size, quality in TIERS:
        (output / tier).mkdir(parents=True, exist_ok=True)
        files = []
        for face in FACES:
            destination = output / tier / f"{face}.webp"
            temporary = destination.with_suffix(".webp.tmp")
            picture = (Image.fromarray(render(cube_rays(face, size))) if render is not None
                       else face_images[face].resize((size, size), Image.Resampling.LANCZOS))
            picture.save(
                temporary, "WEBP", quality=quality, method=6)
            temporary.replace(destination)
            files.append({"file": f"{tier}/{face}.webp", "bytes": destination.stat().st_size,
                          "sha256": sha256(destination)})
        manifest["tiers"][tier] = {"size": size, "quality": quality, "files": files,
                                   "bytes": sum(f["bytes"] for f in files),
                                   "gpuBytesRGBA8": 6 * size * size * 4}
        print(f"{tier}: {size}px × 6, {manifest['tiers'][tier]['bytes']:,} bytes", flush=True)
    export_thumbnail(output, manifest)
    temporary = output / "manifest.json.tmp"
    temporary.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    temporary.replace(output / "manifest.json")
