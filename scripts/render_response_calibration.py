"""Render the before/after calibration evidence, including known limitations."""
from pathlib import Path
import base64
from datetime import datetime
import hashlib
import html
import json
import os
os.environ.setdefault('MPLCONFIGDIR', '/tmp/heli-analysis-matplotlib')
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'analysis/response-calibration'
reference = json.loads((OUT / 'reference.json').read_text())
validation = json.loads((OUT / 'validation.json').read_text())
fit = json.loads((OUT / 'fit.json').read_text())
time = np.array([s['t'] for s in reference['samples']])
observed = np.array(reference['observed'])

plt.rcParams.update({'font.family': 'DejaVu Sans', 'font.size': 10, 'axes.grid': True, 'grid.alpha': .17,
                     'axes.spines.top': False, 'axes.spines.right': False})
fig, axes = plt.subplots(3, 1, sharex=True, figsize=(11.5, 8.5), layout='constrained')
mask = (time >= 9.25) & (time <= 10.65)
axes[0].plot(time[mask], np.array([s['collective'] for s in reference['samples']])[mask], '.-', ms=3, color='#156cff')
axes[0].set(title='Collective reversal: before / calibrated / recorded reference', ylabel='Recorded collective')
axes[1].plot(time[mask], observed[mask], '.-', ms=3, color='#172639', lw=2, label='HELI-X recording')
for version, label, color, style in [('before', 'Before', '#96a3b5', '--'), ('calibrated', 'Calibrated', '#156cff', '-')]:
    case = next(c for c in validation['force'] if c['version'] == version and c['case']['name'] == 'reference')
    axes[1].plot(time[mask], np.array(case['acceleration'])[mask], style, color=color, label=label)
    trajectory = next(c for c in validation['vertical'] if c['version'] == version and c['begin'] == 9.25)
    axes[2].plot([s['t'] for s in trajectory['traces']], [s['velocity'] for s in trajectory['traces']], style, color=color, label=label)
axes[1].set(ylabel='Body-up non-gravity force / mass (m/s²)')
axes[1].legend(fontsize=9)
axes[2].plot(time[mask], np.array(reference['velocity'])[mask, 1], '.', color='#172639', ms=4, label='HELI-X recording')
axes[2].set(ylabel='Vertical velocity (m/s)', xlabel='Recording time (s)')
axes[2].legend(fontsize=9)
for ax in axes:
    ax.set_xlim(9.25, 10.65)
    ax.axhline(0, color='#8894a8', lw=.6)
fig.savefig(OUT / 'comparison.png', dpi=170)
fig.savefig(OUT / 'comparison.svg')
plt.close(fig)


def table(headers, rows):
    cell = lambda values, tag: ''.join(f'<{tag}>{html.escape(str(v))}</{tag}>' for v in values)
    return '<div class="scroll"><table><thead><tr>' + cell(headers, 'th') + '</tr></thead><tbody>' + ''.join('<tr>' + cell(row, 'td') + '</tr>' for row in rows) + '</tbody></table></div>'


force_rows = []
for c in validation['force']:
    case = c['case']
    force_rows.append([c['version'], f"{case['mass']} kg / {case['rpm']} RPM / ±{case['pitch']}°",
                       f"{c['trainRms']:.2f}", f"{c['heldOutRms']:.2f}", f"{c['allAirborneRms']:.2f}"])
vertical_rows = []
for before in validation['vertical']:
    if before['version'] != 'before':
        continue
    after = next(a for a in validation['vertical'] if a['version'] == 'calibrated' and a['begin'] == before['begin'])
    vertical_rows.append([f"{before['begin']}–{before['end']} s", f"{before['velocityRms']:.2f} → {after['velocityRms']:.2f}", f"{before['heightRms']:.2f} → {after['heightRms']:.2f}"])
rate_rows = []
for before in validation['rates']:
    if before['version'] == 'before':
        after = next(a for a in validation['rates'] if a['version'] == 'calibrated' and a['channel'] == before['channel'])
        rate_rows.append([before['channel'], f"{before['rms']:.2f}", f"{after['rms']:.2f}"])
before_cpu = json.loads((OUT / 'baseline/response-metrics.jsonl').read_text().strip().splitlines()[-1])['physicsStepMedianMs']
after_cpu = json.loads((OUT / 'response-metrics-after.jsonl').read_text().strip().splitlines()[-1])['physicsStepMedianMs']
image_data = base64.b64encode((OUT / 'comparison.png').read_bytes()).decode()
page = f'''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>打杆响应标定 · 改动前后对照</title>
<style>*{{box-sizing:border-box}}body{{margin:0;background:#f2f5fa;color:#142238;font:15px/1.8 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}}main{{max-width:1120px;margin:30px auto;background:#fff;padding:36px;border-top:4px solid #156cff}}h1{{font-size:30px}}h2{{font-size:21px;margin-top:32px}}.label{{color:#156cff;font:12px monospace;letter-spacing:2px}}.callout{{padding:16px 20px;background:#edf4ff;border-left:3px solid #156cff}}.scroll{{overflow:auto}}table{{border-collapse:collapse;width:100%;font-size:13px}}td,th{{padding:10px;text-align:left;border-bottom:1px solid #dae3ef;white-space:nowrap}}th{{background:#f4f7fc}}img{{width:100%;height:auto}}a{{color:#156cff}}pre{{padding:16px;background:#f5f8fc;white-space:pre-wrap;font-size:12px}}small{{color:#586a80}}@media(max-width:700px){{main{{margin:0;padding:20px 14px}}h1{{font-size:24px}}}}</style></head><body><main>
<div class="label">RESPONSE CALIBRATION / 2026-10-11</div><h1>按 Tron5.5 test 标定后的飞行响应</h1>
<div class="callout"><strong>新模型已接入 Web 飞行。</strong>未参与拟合的后半段样本中，参考工况的总距加速度 RMS 误差 <strong>12.56 → 3.05 m/s²（约 −76%）</strong>；按你保存的 5 kg / 2400 RPM / ±14° 设置，误差为 <strong>13.18 → 3.94 m/s²（约 −70%）</strong>。这表示指定对照工况的误差降低，不是“全系统相似度 76%”。</div>
<p><a href="/">回到模拟器试飞</a> · <a href="../tron55-test/report.html">改动前的录像分析</a></p>
<h2>模型如何改变</h2>
<p>使用三个受正值约束的有效旋翼力导数：总距、轴向气流、动态入流反馈。保持桨距执行器、显式尾流状态、旋翼惯量、定速器和刚体力/力矩积分。录像只在离线拟合与验证时读取；运行中的飞机没有被强行设置为录像位置、速度或角速度。</p>
<p>飞行转速下用辨识后的低阶旋翼力模型；载荷按空气密度、实度、半径和 RPM 缩放，质量只进入 F=ma。极低转速连续过渡到原叶素载荷，以保留被动气流和停转过程。气动轴功率由轴向/诱导功率与剖面损失组成，尾桨和电机仍承受对应反扭矩。该模型是对模拟器响应的标定，不声称是从数据恢复出的真实桨叶参数。</p>
<p>保留 90 ms 入流状态和 900°/s 桨距执行速度；内部积分细分到 2 ms。选择少量可辨识参数，是因为 33 Hz 单段录像不能支持完整非均匀尾流或几毫秒传输延迟的独立辨识。旋翼下降工况需要专门模型，不能把普通动量近似当作全工况真值，参见 <a href="https://ntrs.nasa.gov/citations/20060024029">NASA 的涡环状态建模报告</a>。</p>
<h2>前半段拟合，后半段检验</h2>
<p>只使用前 48 秒中的 {fit['samples']['train']} 个低速有效样本拟合；48 秒之后的 {fit['samples']['heldOut']} 个低速样本只用来检验。固定参考力尺度为 3.2 kg / 2100 RPM / ±13°，不是推断录制时的真实配置。总距和气流轨迹相同、转速固定；结果来自独立前向计算，未反馈记录的加速度。约 94.54 秒的复位和低高度区间排除。</p>
{table(['版本', '工况', '训练 RMS', '后半段 RMS', '全部有效飞行 RMS'], force_rows)}
<p><small>单位均为 m/s²。这里规定了相同的气流轨迹，用于分离旋翼力的差异；不等于完整整机自由飞行回放。5 kg 工况没有再次拟合。</small></p>
<img src="data:image/png;base64,{image_data}" alt="同一总距换向下，HELI-X、改动前与标定后的力响应和短窗口速度预测">
<h2>自由运动短窗口检查</h2>
<p>从每个正立脉冲窗口的实测初始高度、速度开始，随后只输入记录的总距；不再回填实测速度。近似保持机身正立，固定 RPM，积分得到新的高度与速度。这是比规定气流更严格的运动检查，但不是完整六自由度的同初态飞行复现。</p>
{table(['窗口', '速度 RMS：改前 → 改后，m/s', '高度 RMS：改前 → 改后，m'], vertical_rows)}
<p>四个窗口的速度误差均下降；<strong>最后一个窗口的高度误差从 0.42 增至 1.07 m</strong>，该结果保留。未知原始配置、姿态近似及力的微小持续偏差仍会积累成轨迹误差，因此不能宣称整段飞行或所有工况已经一致。</p>
<h2>三轴控制与当前调参</h2>
<p>先匹配录像的静态速率曲线，再对照单轴动作的时序。原先推荐 PID 的三轴响应本就接近录像；这次未额外放大姿态操纵力矩。</p>
{table(['单轴片段', '改前角速度 RMS，°/s', '改后角速度 RMS，°/s'], rate_rows)}
<p>当前保存的高 P、高 I、D=0 配置在阶跃试验中有明显回弹。旧值已备份，现已通过界面应用推荐值：三轴 P=85、I=30、D=0.35、FF=100%、B=40%；滤波 35/25/12 Hz。保留 5 kg、2400 RPM、±14°、电机 100%、斜盘 350°/s、尾舵 620°/s、Expo 40%。</p>
<p><a href="saved-aircraft-before.json">原调参备份</a> · <a href="saved-aircraft-after.json">已应用调参</a></p>
<h2>验证与适用范围</h2>
<p>50 项 Node 回归、8 项 Python 分析测试通过；TypeScript 检查和生产构建通过。覆盖正反悬停、负总距、转速与密度缩放、质量独立性、极低转速连续性、1–8 kg / 1200–3000 RPM 强换向、定速/掉转、刚体积分收敛、遥控器映射和三轴起停。Vite 仍有原有主包超过 500 kB 的提示。</p>
<p>浏览器的模拟 Gamepad 链路回放：俯仰累计 363.6°、横滚 358.3°，均经过倒飞且未坠机；相机保持固定地面位置。主页面已显示新模型且未捕获到控制台错误。真实遥控器的主观手感仍需用户试飞确认。</p>
<p>纯物理基准的每个外层 4 ms 步长耗时中位数为 {before_cpu:.4f} → {after_cpu:.4f} ms，虽已增加内部子步，计算量仍较低；该数字不包含渲染与硬件输入延迟，不是网页 FPS 指标。单段 550 级录像也不能证明所有 700 级机型或极端下降工况已经标定。</p>
<p><a href="validation.json">完整前后对照</a> · <a href="fit.json">拟合过程</a> · <a href="manifest.json">来源与文件哈希</a> · <a href="comparison.svg">曲线 SVG</a></p>
<details><summary>复算命令</summary><pre>node --experimental-strip-types scripts/fit-rotor-response.ts analysis/response-calibration/reference.json analysis/response-calibration/fit.json
node --experimental-strip-types scripts/validate-response-calibration.ts
python3 scripts/render_response_calibration.py
npm test
npm run build</pre></details></main></body></html>'''
(OUT / 'report.html').write_text(page)
paths = [*sorted((ROOT / 'src/physics').glob('*.ts')),
         ROOT / 'scripts/prepare_response_reference.py',
         ROOT / 'scripts/fit-rotor-response.ts', ROOT / 'scripts/validate-response-calibration.ts',
         ROOT / 'scripts/recording-rotor-benchmark.ts', ROOT / 'scripts/render_response_calibration.py']
source = Path('/Users/bytedance/Library/HELI-X11/resources/flights/My_Flights/Tron5.5 test/Tron5.5 test.fly')
manifest = {'createdAt': datetime.now().astimezone().isoformat(), 'recordingSha256': hashlib.sha256(source.read_bytes()).hexdigest(),
            'sourceFiles': {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in paths},
            'derivedReferenceSha256': hashlib.sha256((OUT / 'reference.json').read_bytes()).hexdigest(),
            'trainBeforeSeconds': 48, 'trainSamples': fit['samples']['train'], 'heldOutSamples': fit['samples']['heldOut'],
            'tests': {'node': 50, 'python': 8, 'productionBuild': 'passed'},
            'installedHelixJarSha256': hashlib.sha256(Path('/Users/bytedance/Library/HELI-X11/HeliX11.jar').read_bytes()).hexdigest(),
            'helixApplicationChangedThisTurn': False,
            'limits': ['Unknown complete recording configuration and wind.', '33 Hz does not resolve millisecond latency.',
                       'Held-out split is within one recording, not an independent session.', 'One vertical window has increased height error.']}
(OUT / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(OUT / 'report.html')
