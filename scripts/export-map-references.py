#!/usr/bin/env python3
"""Split an equirectangular mother image into six lossless generation references.

Uses the project's actual Three.js image-cubemap frame. Does not generate new
detail, change the source, or write runtime map assets.
"""
import argparse
import json
import math
import zipfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from equirectangular import Equirectangular, sun_direction
from map_assets import cube_rays, sha256

ROOT = Path(__file__).resolve().parents[1]
VIEWS = (
    ("01-forward", "前方", "+X", "left"),
    ("02-right", "右侧", "+Z", "front"),
    ("03-rear", "后方", "-X", "right"),
    ("04-left", "左侧", "-Z", "back"),
    ("05-up", "正上方", "+Y", "top"),
    ("06-down", "正下方", "-Y", "bottom"),
)


def sun_in_face(face, sun):
    """Locate the sun using the same face basis as the actual texture exporter."""
    grid = cube_rays(face, 3)
    forward = grid[1, 1]
    right = (grid[1, 2] / np.dot(grid[1, 2], forward) - forward) * 1.5
    down = (grid[2, 1] / np.dot(grid[2, 1], forward) - forward) * 1.5
    distance = np.dot(sun, forward)
    if distance <= 0:
        return None
    uv = np.array([np.dot(sun, right), np.dot(sun, down)]) / distance
    return ((uv + 1) / 2).tolist() if np.max(np.abs(uv)) <= 1 else None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=ROOT / "scripts/maps/river-meadow.json")
    parser.add_argument("--output", type=Path, help="Default: assets/maps/<id>/six-face-references")
    parser.add_argument("--size", type=int, help="Default: approximate source centre angular density, rounded up to 16px")
    args = parser.parse_args()
    config = json.loads(args.config.read_text())
    source = ROOT / config["source"]
    if sha256(source) != config["sourceSha256"]:
        raise ValueError("Source differs from the calibrated mother image")
    with Image.open(source) as original:
        rgb = np.asarray(original.convert("RGB"))
    size = args.size or math.ceil(rgb.shape[1] / math.pi / 16) * 16
    if not 64 <= size <= 4096:
        raise ValueError("Reference face size must be between 64 and 4096")
    heading = config["calibration"]["headingDegrees"]
    sampler = Equirectangular(rgb, heading)
    sun = sun_direction(config["calibration"]["sunUV"], heading)
    output = args.output or ROOT / "assets/maps" / config["id"] / "six-face-references"
    for directory in (output / "faces", output / "prompts"):
        directory.mkdir(parents=True, exist_ok=True)
    records, images = [], []
    for name, label, axis, face in VIEWS:
        path = output / "faces" / f"{name}.png"
        picture = Image.fromarray(sampler.render(cube_rays(face, size)))
        picture.save(path)
        images.append(picture)
        solar_uv = sun_in_face(face, sun)
        light = (f"本面太阳中心约在图片宽度的 {solar_uv[0]*100:.2f}%、高度的 {solar_uv[1]*100:.2f}%。保持这一位置和单一太阳。"
                 if solar_uv else "太阳圆盘位于当前画面之外，本面不要新增太阳或耀斑。")
        content = ("这是正上方天空视角，保持云层的位置、尺度和太阳方向；不要新增地平线或地面。" if face == "top" else
                   "这是垂直向下看草地的视角，满画面都是平坦草地；不要新增地平线、天空、河流、相机或人物影子。" if face == "bottom" else
                   "这是水平视角，保持地平线在原参考图中的位置。保留原图实际可见的河岸、树线及草地分布，不给没有河流的位置补画河流。")
        prompt = f"""请以附图 {name}.png 为编辑目标，生成同一飞场同一方向的高清图。

目标：单张 2048×2048 PNG，原生生成细节，适合 360° 飞场立方体贴图。
当前方向：{label}，世界坐标 {axis}。这是立方体的一张 90°×90° 直线透视面。
严格保持参考图的相机位置、视场角、朝向、画面裁切、地平线及物体轮廓。
不旋转、不翻转、不改变构图、不自动拉近、不改为鱼眼或等距柱状全景、不输出拼图。
{content}
细化参考图中已经存在的景物，增加自然清晰的纹理细节，保持原有空间位置，不新增景物种类。
沿用自然日光、草地绿色、天空色温和曝光；保持统一光源及阴影方向。
{light}
四条边需要和其他立方体面拼接，请保留贴边物体的位置、轮廓和色调，不新增截断的物体。
不添加直升机、人物、动物、车辆、建筑、围栏、文字、水印、参考线或边框。
避免过度锐化、虚假 HDR、浅景深和涂抹感。
如另附全景母图，仅用它统一全场色彩和场景，不改变本张编辑目标的 90° 视角。
"""
        prompt_path = output / "prompts" / f"{name}.txt"
        prompt_path.write_text(prompt)
        records.append({"reference": f"faces/{name}.png", "direction": label,
                        "worldAxis": axis, "projectFace": face, "size": [size, size],
                        "fovDegrees": [90, 90], "sunUV": solar_uv,
                        "prompt": f"prompts/{name}.txt", "sha256": sha256(path)})
    # A labelled sheet is a guide only; the six actual input images have no labels.
    tile, gap, heading_height = 320, 16, 52
    overview = Image.new("RGB", (3 * tile + 4 * gap, 2 * (tile + heading_height) + 3 * gap), "#111b26")
    draw = ImageDraw.Draw(overview)
    font = ImageFont.load_default(size=18)
    for i, ((name, _, axis, face), picture) in enumerate(zip(VIEWS, images)):
        x = gap + i % 3 * (tile + gap)
        y = gap + i // 3 * (tile + heading_height + gap)
        draw.text((x, y), name.upper() + " [" + axis + "]", fill="white", font=font)
        draw.text((x, y + 24), f"Project texture: {face}.webp", fill="#a9c1d5", font=font)
        overview.paste(picture.resize((tile, tile), Image.Resampling.LANCZOS), (x, y + heading_height))
    overview.save(output / "overview.png")
    manifest = {"source": config["source"], "sourceSha256": sha256(source),
                "sourceSize": [rgb.shape[1], rgb.shape[0]], "headingDegrees": heading,
                "processing": "Direct spherical reprojection of the original; no sharpening, seam feather, generation or new detail.",
                "recommendedGeneratedSize": [2048, 2048], "faces": records}
    (output / "references.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    table = "\n".join(f"| {name}.png | {label} | {axis} | {face}.webp |" for name, label, axis, face in VIEWS)
    (output / "README.md").write_text(f"""# 河畔飞场：六面生成参考包

`faces/` 中是你要分别上传生成的 **6 张无损 PNG**，每张 {size}×{size}，视角严格为水平 / 垂直 90°。它们由 1774×887 母图直接球面重投影而来，保持原有构图与色彩，**是低分辨率构图参考，不是高清生成结果**。参考尺寸依据母图中心角分辨率选取；没有把它放大到 2048px 来冒充高清。

## 分别生成

1. 上传一张 `faces/` 图片作为编辑目标，复制 `prompts/` 中同名提示词。不要上传 overview.png 让模型重绘六宫格。
2. 每张统一生成 **2048×2048 PNG**。保持 90° 视场、相机朝向、构图、地平线及贴边物体位置。不要改变裁切、镜像或旋转。
3. 如工具支持第二张参考图，可附原始全景 `source.png` 统一色彩和场景；以单面图的透视和构图为准。打包 ZIP 中该母图位于 `context/mother-panorama.png`。
4. 生成结果建议继续使用同一编号文件名，另存到新文件夹，保留这套原始参考用于拼接对照。
5. 六张生成完后检查所有接边。四个水平方向的地平线、河岸及色温要一致；天空图中的太阳只能有一个，正下方只保留草地。AI 可能改动几何，提示词不能保证无缝。

## 方向和项目文件对应

方向是相对游戏默认视角，编号从正前方开始向右绕一圈，再到上下。**项目文件名受 Three.js 图片立方体坐标约定影响，不能按英文名称直觉替换。**

| 参考图文件 | 人眼方向 | 世界轴 | 对应项目纹理 |
| --- | --- | --- | --- |
{table}

水平方向按 01 → 02 → 03 → 04 → 01 环绕，每张右边接下一张左边。上下图片已经采用项目要求的朝向，导回时保留文件自身方向；在平面编辑器中摆成立方体展开图时，上下图片可能需要临时旋转来对边。

六面图是透视投影，不能直接横向拼成一张等距柱状 2:1 全景。如果最终要全景，需要用支持 cubemap 的软件进行球面重投影；保留六面也可以直接供当前模拟器使用。

`references.json` 记录源图哈希、各面方向、光源位置和资源哈希。`overview.png` 仅用于查看编号。当前游戏地图未改动。

## 重新导出

在项目根目录、已安装 NumPy 和 Pillow 的 Python 环境运行：

```sh
python scripts/export-map-references.py
```

支持 `--config`、`--output` 和 `--size`。改变参考图像素尺寸不会增加源图细节。
""")
    archive = output.with_suffix(".zip")
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
        for path in sorted(output.rglob("*")):
            if path.is_file():
                bundle.write(path, f"{output.name}/{path.relative_to(output)}")
        bundle.write(source, f"{output.name}/context/mother-panorama.png")
    print(f"Six {size}×{size} references: {output}")
    print(f"Archive: {archive} ({archive.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
