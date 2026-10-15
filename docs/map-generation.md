# 生成式飞场工作流

目标：用球面全景或六面贴图，构建地面固定机位的轻量飞场。生成和纹理转换都在离线阶段完成，浏览器沿用 `PhotoField`，不增加模型调用、拼接库或地形网格。当前默认地图是 **河畔草地飞场 · 高清**；低清母图版本和 X5 实拍地图仍保留。

## 高清六面导入测试（2026-10-15）

用户在 `assets/newmap/` 提供六张分别增强后的 **4096×4096 PNG**，合计 197,168,422 字节。来源使用用户说明记录，未推断增强模型。原文件保留；运行时加载的是 `public/environments/river-meadow-hd/`，不下载这些 PNG。

新增 `scripts/prepare-cubemap.py` 直接导入六面。只做 sRGB 规范化、Lanczos 缩小和 WebP 编码，**没有转回低分辨率全景，也没有锐化或模糊接缝**。原图的方向映射和 SHA-256 在 `scripts/maps/river-meadow-hd.json`，导入器拒绝缺面、非正方形、低于 2048px、尺寸不一致及哈希变化。

| 用户文件名前缀 | 项目纹理 | 世界方向 |
| --- | --- | --- |
| forward | left | +X |
| right | front | +Z |
| rear | right | −X |
| left | back | −Z |
| up | top | +Y |
| down | bottom | −Y |

- 预览：6 × 256px，WebP 72，**93,232 字节**。
- 标准：6 × 2048px，WebP 92，**7,230,188 字节**。
- 合计 **7,323,420 字节，约 7.32 MB**。高清地图单独使用 8 MB 下载预算；原有两张地图仍使用 5 MB。增加预算用于保留草地细节，标准背景显存仍为 **96 MiB**。
- 天空图中的太阳位置重新测量为 UV `(0.7530277, 0.8307955)`，世界方位约 **127.41°**、仰角 **50.21°**。场景光源已同步。

使用与原流程相同的 NumPy / Pillow 离线环境，在项目根目录执行：

```sh
npm run map:import-faces
npm run map:test
npm test
npm run build
```

替换某张增强图时，先确认它的方向及 90° 裁切，再更新配置中的文件名和哈希、重测太阳坐标后重新导入。`src/field.ts` 当前导入 `river-meadow-hd/manifest.json`；可以改回 `river-meadow/manifest.json` 对照低清母图版本。

导入器按世界方向配对全部 12 条立方体边缘，记录端点顺序及两像素边带的 RGB 差异。该数值只用于发现色调 / 纹理不连续，不能证明几何无缝。当前未修接缝，manifest 明确标记为导入测试。

浏览器验证结果：初始前向草地细节明显改善，四周方向正确，太阳、悬停阴影正常。四条水平接缝均有不同程度的亮度、云层或地面纹理断点；后 / 左草地边界明显；天空顶面和侧面之间存在明显色块。脚下与水平面的纹理差异也需要后续修补。此次保留原貌便于对比，尚未完成无缝验收。

`/tests/field-harness.html` 新增 **固定检查视角** 下拉框，可直接查看四周、上下、四条水平接缝以及前方与天空 / 脚下的交界。本地检查截图在 `analysis/river-meadow-hd/`。120 项 Node 测试、8 项 Python 测试和生产构建通过；构建仍有原有 JS 主包超过 500 kB 的提示。

## 最初母图产物（保留记录）

| 项目 | 路径 / 数值 |
| --- | --- |
| 原始生成图 | `assets/maps/river-meadow/source.png` |
| 实际使用的完整提示词 | `assets/maps/river-meadow/prompt.txt` |
| 生成记录、方向及光照配置 | `scripts/maps/river-meadow.json` |
| 可部署素材 | `public/environments/river-meadow/` |
| 当前地图入口 | `src/field.ts` |
| 原图尺寸 | **1774 × 887**，原图保留，不进入网页下载 |
| 预览 | 6 × 256px，WebP 72，62,340 字节 |
| 标准 | 6 × 2048px，WebP 92，2,162,982 字节 |
| 纹理下载总量 | **2,225,322 字节，约 2.23 MB**（不含 manifest） |
| 背景显存 | 标准 RGBA8 约 96 MiB；预览 1.5 MiB；反射、阴影另计 |
| 初始视线 | 世界 +X，开阔草地，河流位于远景 |
| 太阳 | 相对初始方向右后方约 125.54°，仰角约 50.23° |

本次采用 **Codex 内置 `image_gen`**。用户指定的模型记为 `gpt-image-2`；工具响应未返回实际模型标识，因此 `reportedModel` 为 `null`，不把请求值当成验证结果。提示词要求 3840 × 1920，实际输出是 1774 × 887。

**画质边界：**原图每 90° 只有约 443.5 个横向像素。2048px 六面是项目纹理规格，重采样不会补出真实细节，本次没有做 AI 超分辨率。默认 42° 视野及继续放大时，清晰度仍受生成源图限制。提高 WebP 质量能减少编码损失，无法替代高分辨率源图；后续换成更高分辨率源图时重新标定并运行同一导入流程。

## 1. 生成并归档原图

为每个飞场创建独立的 `assets/maps/<id>/`，先保存 `prompt.txt`，再把生成工具实际返回的文件复制为 `source.png`。保留工具原始输出，记录真实尺寸和来源；重新生成用新版本文件，不覆盖原图。

提示词必须包含：

- 完整 **360° × 180° 等距柱状全景**，宽高比 2:1；不是普通广角照片或六宫格。
- 眼高约 1.8 m，地平线水平且接近画面中线，头顶 / 脚下使用球面极区拉伸，左右边缘是同一方向。
- 中央方向是无障碍起降草地，远处河流、低矮树线；全周地面平坦，近处没有人、飞机、建筑、围栏或水面。
- 一处太阳，明确相对方位及仰角，避免前方眩光；阴影和光照一致。
- 尽可能高的原生分辨率、清晰草地，禁止浅景深、文字、水印、镜头光斑。

内置生成：使用上述 `prompt.txt` 调用 `image_gen`，将实际输出复制到项目。内置工具没有可用的 `model` / `size` 参数，提示词中的尺寸是期望值，必须检查输出。

需要**显式选择 gpt-image-2 和输出尺寸**时，可使用 imagegen 技能附带的 CLI。前提是在本机配置 `OPENAI_API_KEY`、安装其依赖并具有网络访问；不要把密钥写入仓库。此路径本次未执行：

```sh
IMAGE_GEN="${CODEX_HOME:-$HOME/.codex}/skills/.system/imagegen/scripts/image_gen.py"
python "$IMAGE_GEN" generate \
  --model gpt-image-2 --size 3840x1920 --quality high \
  --prompt-file assets/maps/river-meadow/prompt.txt \
  --out assets/maps/river-meadow/source-v2.png
```

这会产生新的构图；不能沿用旧图的太阳坐标和 SHA。生成本身不保证可复现，同一张归档原图的转换则可重复执行。不同 Pillow/libwebp 版本可能改变编码字节，manifest 会记录编码器版本和新的哈希。

## 2. 检查投影、朝向与太阳

先看全景原图，再看六面和浏览器中的环视。地平线不应在左右接缝处错位，河流不能在近处截断草地。生成图存在弯曲地平线、重复太阳、接缝处物体断裂时，应定向重生成；不能用宽范围模糊掩盖。

复制 `scripts/maps/river-meadow.json` 为新地图配置，更新 `id`、`name`、原图和提示词路径、SHA-256、`generation` 记录以及 `calibration`。生成图和提示词可通过 `shasum -a 256 <文件>` 取得哈希。导入器拒绝与已校准哈希不符的原图。

项目坐标为 X 前、Y 上、Z 右；Three.js 图片立方体带 X 翻转。共享的 `scripts/map_assets.py` 已处理这一约定，不能直接套用常见 cubemap 图片命名。六面顺序固定为 `right, left, top, bottom, front, back`，其中 `left` 图片中心对应世界 +X。

`headingDegrees` 表示原图中要作为世界 +X 的经度：0 对应原图横向中心；90 对应宽度的 75%。草地前方在图片中央，因此本图为 0。旋转烘焙进纹理，运行时 `backgroundYaw=0`。

`sunUV` 是**未经旋转的原图**上实际太阳圆盘中心的归一化坐标，按像素中心 `(x+0.5)/W, (y+0.5)/H` 计算。不要直接采用提示词要求的位置。本图测得约 `(0.8487184, 0.2209469)`。

```text
方位 λ = (u − 0.5) × 360° − headingDegrees
仰角 φ = (0.5 − v) × 180°
sunDirection = (cosφ cosλ, sinφ, cosφ sinλ)
lightRay = −sunDirection
```

转换器同时旋转背景和光源，避免只旋转背景造成阴影错位。眼高与起飞距离分别设为 1.8 m / 9 m，都是场景假设。全景不能恢复真实测距；远处河流仅为背景，碰撞与深度遮挡继续使用 `y=0` 平面。

本图只在左右端各 **4°** 的窄带内羽化到共同颜色，并收敛上下 **2°** 极区颜色，消除环绕与极点颜色跳变；前方草地不受处理。它不修复几何错误。原图保持不变，处理参数、前后接缝误差写入 manifest。

## 3. 离线构建

通用生成图导入只需要 NumPy 和 Pillow，无需 RAW 解码器。Python 3.11+，在项目根目录运行：

```sh
python3 -m venv .venv-panorama
source .venv-panorama/bin/activate
python -m pip install -r scripts/requirements-generated-map.txt
npm run map:prepare -- --config scripts/maps/river-meadow.json \
  --review analysis/river-meadow-panorama.png
npm run map:test
npm test
npm run build
```

默认写入 `public/environments/<id>/`，可用 `--output /tmp/field-review` 先导出检查。输出文件以临时文件替换，manifest 最后更新。源图、配置和提示词在 `public/` 外，生产构建只分发十二张 WebP 和 manifest。

X5 DNG 仍用 `scripts/prepare-panorama.py` 和 `scripts/requirements-panorama.txt`；两条流程共用六面采样方向、256 / 2048 尺寸、WebP 72 / 92 和 manifest 结构。每张地图下载预算 5 MB；超过预算时先评估画质和源图，避免直接大幅降低纹理分辨率。

## 4. 接入和验收

把 `src/field.ts` 的 manifest 导入改为新地图路径。当前无需修改 `PhotoField`、相机和物理；页面暂未开放地图选择菜单。Vite 会打包 `public/environments/` 中保留的地图，但启动时只请求当前地图的纹理。

```sh
npm run dev -- --port 5177 --strictPort
```

打开 `/tests/field-harness.html`：

1. 地面 / 2 米悬停 / 8 米悬停 / 倾斜机体：检查初始草地朝向、地平线、接地和阴影。
2. 朝向太阳：太阳圆盘应在视线中心附近，允许生成光晕及像素测量误差。
3. 环视接缝：查看各面交界与后方环绕，检查天空和草地是否断层。
4. 地下遮挡：机体应被地面遮住。
5. `?fail=preview` 应加载到 standard；`?fail=standard` 应保留 preview；`?fail=all` 应显示 unavailable，渲染与碰撞继续工作。
6. 打开 `/` 检查真实初始画面；保存场景截图作为本次视觉验收记录。

自动测试覆盖六面坐标、经度环绕、极点采样、朝向和太阳同步旋转、窄带处理范围、错误输入 / 源图哈希、两张地图的资源完整性、下载 / 显存预算，以及原有地面投影和飞行回归。自动测试不会评价生成画面的真实性或清晰度，仍须查看实际画面。

## 本次验收记录（2026-10-15）

117 项 Node 回归、5 项 Python 投影测试、TypeScript 和生产构建通过；两张地图的 24 张 WebP 尺寸与清单一致。浏览器已验证标准纹理、2 m 悬停阴影、太阳居中、地下遮挡及 preview / standard / all 三种加载失败回退。环视已抽查，未做每个方向的逐像素视觉认证。首页截图保存在本地 `analysis/river-meadow-preview.jpg`（分析目录不提交）。

最初母图版本可运行，放大后仍明显受 1774px 宽源图限制，不能视作高清纹理验收通过。生产构建保留已有主 JS 包大于 500 kB 的提示；这次未新增浏览器依赖。

## 运行时地图目录与缓存（v0.2.0）

`src/field.ts` 的 `fields` 注册三张地图，第一项 `defaultField` 为高清河畔。新增地图须显式加入目录，保持相同地面高度及六面标准；图片仍放在 `public/environments/<id>/`，仅元数据进入主 JS。

`FieldAssets` 是生产环境唯一的飞行场景纹理获取入口：默认图可自动加载；非默认地图只有 `download()`（按钮触发）允许访问网络，`source()` 始终只读缓存。每次地图导出更新 SHA 后，旧缓存不能冒充新素材。新地图切换同步使用自己的太阳、环境反射和机位。

飞场设置使用响应式缩略图网格。共用导出器 `scripts/map_assets.py` 会从 `standard/left.webp`（初始 +X 视角）居中裁切生成独立的 `thumbnail.webp`：640×400、WebP quality 82，并将尺寸、字节数、SHA-256 写入 manifest 的 `thumbnail` 字段。只有打开飞场设置才赋值图片 URL，URL 携带 SHA 以更新浏览器缓存；缩略图不属于十二张场景纹理，不影响地图的下载大小及「已下载」判定。图片不可用时显示占位提示，下载和切换按钮仍然可用。

用户增强的 `assets/newmap/` 原始 PNG 及可重建的六面参考包留在本地，不提交 Git；部署所需的 36 张 WebP 和三个 manifest 均随仓库提供。重建高清地图时，需自行放回配置中列出的六张原始图。
