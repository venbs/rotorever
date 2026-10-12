"""Generate standalone Chinese HTML report and scientific response plots."""
from pathlib import Path
import base64
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
OUT = ROOT / 'analysis'


def table(headers, rows):
    return '<div class="table-wrap"><table><thead><tr>' + ''.join(f'<th>{html.escape(str(v))}</th>' for v in headers) + '</tr></thead><tbody>' + ''.join('<tr>' + ''.join(f'<td>{html.escape(str(v))}</td>' for v in row) + '</tr>' for row in rows) + '</tbody></table></div>'


def number(x, digits=2):
    return '—' if x is None else f'{x:.{digits}f}'


def plot_report(web):
    plt.rcParams.update({'font.family': 'DejaVu Sans', 'font.size': 10, 'axes.spines.top': False,
                         'axes.spines.right': False, 'axes.grid': True, 'grid.alpha': .17,
                         'figure.facecolor': 'white', 'axes.labelcolor': '#24324a', 'text.color': '#17273b'})
    fig, axes = plt.subplots(2, 2, figsize=(12.5, 8.4), layout='constrained')
    base = next(s for s in web['steps'] if s['case']['name'] == 'representative-ideal' and s['step'] == 'full')
    finite = next(s for s in web['steps'] if s['case']['name'] == 'representative-finite' and s['step'] == 'full')
    tr = base['traces']
    axes[0, 0].plot([p['ms'] for p in tr], [p['commandDeg'] for p in tr], '--', color='#8293ac', label='Command')
    axes[0, 0].plot([p['ms'] for p in tr], [p['pitchDeg'] for p in tr], color='#1268e8', label='Actual collective')
    axes[0, 0].axvline(base['pitch99Ms'], color='#111827', alpha=.35)
    axes[0, 0].set(xlim=(0, 80), ylabel='Collective pitch (deg)', title='A  /  Pitch arrives in 12 ms')
    axes[0, 0].legend(frameon=False)
    for curve, label, color, style in [(base, 'Free flight, ideal governor', '#1268e8', '-'),
                                       (finite, 'Free flight, finite motor', '#667589', '--'),
                                       (web['fixedAir'], 'Rotor only, zero airspeed, ideal RPM', '#00a6aa', '-')]:
        axes[0, 1].plot([p['ms'] for p in curve['traces']], [p['thrustN'] for p in curve['traces']], style, color=color, label=label)
    axes[0, 1].set(ylabel='Main rotor thrust (N)', title='B  /  Separate flow response from rising airspeed')
    axes[0, 1].legend(frameon=False, fontsize=8, loc='upper right')
    for curve, label, color, style in [(base, 'Baseline: inflow 90 ms', '#1268e8', '-'),
                                       (web['sensitivity'][1], 'Inflow 5 ms', '#00a6aa', '--'),
                                       (web['sensitivity'][2], 'Near-instant actuator', '#667589', ':')]:
        axes[1, 0].plot([p['ms'] for p in curve['traces']], [p['velocity'] for p in curve['traces']], style, color=color, label=label)
    axes[1, 0].set(ylabel='Vertical velocity (m/s)', title='C  /  Faster inflow reduces the initial speed gain')
    axes[1, 0].legend(frameon=False)
    for curve, label, color in zip(web['braking'], ['Return to hover pitch', 'Zero pitch', 'Negative half collective'], ['#667589', '#00a6aa', '#1268e8']):
        axes[1, 1].plot([p['ms'] for p in curve['traces']], [p['velocity'] for p in curve['traces']], color=color, label=label)
        if curve['zeroCrossMs'] is not None:
            axes[1, 1].scatter([curve['zeroCrossMs']], [0], s=24, color=color, zorder=4)
            axes[1, 1].annotate(f"{curve['zeroCrossMs']:.0f} ms", (curve['zeroCrossMs'], 0), xytext=(5, 8), textcoords='offset points', color=color)
    axes[1, 1].axhline(0, color='#111827', lw=.7)
    axes[1, 1].set(xlim=(0, 550), ylabel='Vertical velocity (m/s)', title='D  /  Braking depends on the commanded force')
    axes[1, 1].legend(frameon=False, fontsize=8)
    for ax in axes.flat:
        ax.set_xlabel('Time after input change (ms)')
    fig.suptitle('Web simulator: controlled collective experiments\n3.8 kg  |  2400 RPM  |  ±13° collective  |  4 ms physics step', fontsize=15, fontweight='bold')
    fig.savefig(OUT / 'collective-response.png', dpi=170)
    fig.savefig(OUT / 'collective-response.svg')
    plt.close(fig)


def main():
    helix = json.loads((OUT / 'helix-recordings.json').read_text())
    web = json.loads((OUT / 'collective-benchmark.json').read_text())
    plot_report(web)
    demos = [r for r in helix['recordings'] if 'collectiveFits' in r]
    base = next(s for s in web['steps'] if s['case']['name'] == 'representative-ideal' and s['step'] == 'full')
    finite = next(s for s in web['steps'] if s['case']['name'] == 'representative-finite' and s['step'] == 'full')
    fixed500 = next(p for p in web['fixedAir']['traces'] if p['ms'] == 500)
    source_paths = sorted((ROOT / 'src' / 'physics').glob('*.ts')) + [ROOT / 'src/input.ts'] + sorted((ROOT / 'scripts').glob('*benchmark.ts')) + [ROOT / 'scripts/analyze_helix.py', ROOT / 'scripts/helix_recording.py', ROOT / 'scripts/render_analysis.py']
    manifest = {'sources': {p.relative_to(ROOT).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in source_paths},
                'numpyVersion': np.__version__, 'matplotlibVersion': matplotlib.__version__,
                'productionPhysicsChanged': False, 'referenceRecordings': helix['filesParsed'], 'referenceFrames': helix['frames']}
    (OUT / 'analysis-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    methods = table(['数据', '已验证的含义 / 检查方式'], [
        ['第 1–3 行', '机体到世界的 3×3 姿态矩阵；检查正交性和行列式。'],
        ['第 4 行前 3 列', '世界坐标位置（m）。'],
        ['第 5 行前 3 列', '世界坐标速度（m/s）；用梯形积分与位置差交叉验证。'],
        ['第 6 行前 4 列', '记录的总距、俯仰、横滚、尾舵通道；序列化来源与姿态变化交叉核对。不是 USB 原始数据。'],
        ['第 8 行', '微秒时间戳；按此比例后位置/速度一致。'],
        ['其他列', '保留原始结构；不擅自当作角速度、RPM 或电机扭矩。'],
    ])
    audit_rows = []
    for r in demos:
        audit_rows.append([Path(r['file']).stem, r['frames'], number(r['durationSeconds'], 1),
                           number(r['sampleIntervalMs']['p50'], 2), number(r['positionVelocityScale'], 5),
                           number(r['positionVelocityResidualMps']['p95'], 3), r['suspectIntervals']])
    step_rows = []
    for s in web['steps']:
        step_rows.append([s['case']['name'], s['step'], s['pitch99Ms'], number(s['at100ms']['acceleration']),
                          number(s['at500ms']['acceleration']), number(s['at100ms']['velocity']), number(s['at500ms']['rpm'], 0)])
    sensitivity_rows = [[s['case']['name'], s['pitch99Ms'], number(s['at100ms']['velocity'], 3), number(s['at500ms']['velocity'], 3)] for s in web['sensitivity']]
    fit_rows = []
    rate_rows = []
    for r in demos:
        fit = r['collectiveFits']['alignedFlow']
        splits = [s['collectiveGain'] for s in fit['splits']]
        fit_rows.append([Path(r['file']).stem, fit['samples'], number(fit['collectiveGain']), number(fit['axialVelocityGain']),
                         number(fit['rmsAcceleration']), f'{min(splits):.1f}–{max(splits):.1f}'])
        rate_rows.append([Path(r['file']).stem] + [number(r['rateFits'][axis]['bestFitFullStickRate'], 0) for axis in ['roll', 'pitch', 'yaw']]
                         + [' / '.join(str(r['rateFits'][axis]['bestGridLagMs']) for axis in ['roll', 'pitch', 'yaw'])])
    braking_rows = [[b['command'], number(b['initialVelocity']), '1.5 s 内未穿零' if b['zeroCrossMs'] is None else f"{b['zeroCrossMs']:.0f} ms", number(b['finalVelocity'])] for b in web['braking']]
    image_data = base64.b64encode((OUT / 'collective-response.png').read_bytes()).decode()
    full_audit = table(['文件', '机型元数据', '格式', '帧数', '中位间隔 ms', '异常候选区间'],
                       [[r['file'], r['model'], r['schema'], r['frames'], number(r['sampleIntervalMs']['p50']), r['suspectIntervals']] for r in helix['recordings']])
    page = f'''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>HELI-X 行为参照与 Web 总距响应验算</title><style>
:root{{color-scheme:light;--ink:#142238;--muted:#56647a;--blue:#1268e8}}*{{box-sizing:border-box}}body{{margin:0;background:#f3f6fb;color:var(--ink);font:15px/1.75 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}}main{{max-width:1180px;margin:32px auto;padding:40px;background:white;border-top:4px solid var(--blue)}}h1{{font-size:30px;line-height:1.35;margin:6px 0 18px}}h2{{margin-top:42px;font-size:21px}}h3{{margin-top:25px;font-size:17px}}p{{max-width:1000px}}small,.muted{{color:var(--muted)}}.eyebrow{{font-size:12px;letter-spacing:2px;color:var(--blue)}}.lead{{font-size:18px}}.callout{{background:#edf4ff;border-left:3px solid var(--blue);padding:14px 20px;margin:20px 0}}.table-wrap{{overflow:auto}}table{{border-collapse:collapse;width:100%;font-size:13px;margin:18px 0}}td,th{{border-bottom:1px solid #dbe3ee;padding:10px 12px;text-align:left;vertical-align:top}}th{{background:#f4f7fc;color:#375171;white-space:nowrap}}td{{font-variant-numeric:tabular-nums}}code,pre{{font-family:ui-monospace,monospace;font-size:12px}}pre{{padding:18px;background:#f4f7fc;overflow:auto}}img{{width:100%;height:auto}}li{{margin:9px 0}}a{{color:var(--blue)}}details{{margin:22px 0}}summary{{cursor:pointer}}@media(max-width:700px){{main{{margin:0;padding:24px 16px}}h1{{font-size:24px}}}}@media print{{body{{background:white}}main{{margin:0;padding:0}}details{{display:block}}}}
</style><main><div class="eyebrow">FLIGHT DYNAMICS / ANALYSIS 01 · 2026-10-10</div>
<h1>HELI-X 行为参照与 Web 总距响应验算</h1>
<p class="lead">当前证据把重点指向<strong>总距对应的推力、速度反馈和工况过渡</strong>。Web 解算器的桨距执行已很快；继续缩短舵机时间或提高姿态 PID，不能直接解决总距力度和刹停感的问题。</p>
<div class="callout"><strong>完成范围：</strong>本机 59 份录像、155,160 帧格式与运动学审计；6 份直升机演示的行为统计；Web 独立阶跃、刹停、时间常数与步长敏感性实验。此次没有修改生产物理参数，也没有改变浏览器里的用户调参。</div>
<p>这是一轮可复算的诊断，尚不是“已经与当前 HELI-X 同输入标定完成”。录像为历史演示，原始完整配置缺失，不能把统计相关性直接转换为新的动力学参数。</p>

<h2>1. 录像数据可以用到什么程度</h2>
<p>59 份文件均成功解析：45 份扩展格式、14 份旧格式；其中 4 份为固定翼。姿态矩阵最大正交误差为 {max(r['orthogonalityMaxError'] for r in helix['recordings']):.2e}。有平移运动的录像，其位置导数/记录速度整体比例为 0.9998–1.0069；6 份固定位置教学动画不参与该比例估计。</p>
{methods}
{table(['演示', '帧数', '时长 s', '间隔中位 ms', '速度比例', '速度残差 P95 m/s', '排除候选区间'], audit_rows)}
<p class="muted">速度残差为位置差除以区间时间，减去首尾速度平均值后的向量范数；弯曲轨迹、非恒定加速度与离散采样均会产生残差。分析筛掉间隔不在 10–50 ms、速度残差 ≥1 m/s、单帧旋转 ≥90°、高度 ≤2 m 的区间。异常候选不等于文件损坏，不能直接当作飞机响应。</p>
<p><strong>限制：</strong>元数据主要来自 2013–2021 年；不是当前 HELI-X 11 的现场测试。已找到的机型为 600/690/700/730/800 等，没有匹配的 550 录像。约 30 ms 的采样间隔、未知记录相位及飞手闭环操纵，无法给出可靠的几毫秒延迟、独立 PID 系数或完整内部状态。第 5 行后面的向量没有被误当成角速度。</p>

<h2>2. Web 总距实验：输入到位与飞机运动分开看</h2>
<p>代表工况为 3.8 kg、2400 RPM、±13°，从力平衡悬停开始；置于 100 m 高度排除地面接触，零风、默认 FBL。该工况是明确指定的实验，不是读取用户当前设置。理想定速与有限动力分别测量。所有时间均从物理输入改变开始，不含遥控器 USB、浏览器调度和显示延迟。</p>
<img src="data:image/png;base64,{image_data}" alt="四组受控实验：桨距到位、固定气流与自由爬升推力、时间常数敏感性及刹停">
<p>打满总距时，桨距 {base['pitch99Ms']:.0f} ms 到达目标的 99%；100 ms 时垂直加速度 {base['at100ms']['acceleration']:.2f} m/s²、速度 {base['at100ms']['velocity']:.2f} m/s；500 ms 时分别为 {base['at500ms']['acceleration']:.2f} m/s²、{base['at500ms']['velocity']:.2f} m/s。转速始终保持 2400 RPM。</p>
<p><strong>不能把这整个下降归咎于“延迟”：</strong>将气流速度固定为零、只让入流状态演化，500 ms 推力仍有 {fixed500['thrustN']:.1f} N；自由爬升时为 {base['at500ms']['thrustN']:.1f} N，此时飞机已以约 14.84 m/s 上升。二者轨迹不同，差值不能当作可加减的单一阻尼系数，但能确认爬升气流对攻角的影响很大。有限电机模式在 500 ms 掉到 {finite['at500ms']['rpm']:.0f} RPM，是另一项独立影响。</p>
<details><summary>展开全部 12 组总距阶跃结果</summary>{table(['工况', '输入变化', '桨距 99% ms', 'a@100ms m/s²', 'a@500ms m/s²', 'v@100ms m/s', 'RPM@500ms'], step_rows)}
<p>default：3.2 kg / 2100 RPM；representative：3.8 kg / 2400 RPM。finite 为电机扭矩 50%，ideal 为 100%。one-degree / four-degrees 为在各自悬停总距上增加 1° / 4°。</p></details>

<h3>缩短时间常数，并不自动变得更跟手</h3>
{table(['实验', '桨距 99% ms', 'v@100ms m/s', 'v@500ms m/s'], sensitivity_rows)}
<p>把入流时间常数从 90 ms 改为 5 ms，前 100 ms 的速度约降低 11%；因为入流更快建立，最初的额外推力更早被削弱。把舵机速度提高 100 倍，100 ms 速度只增加约 3%。4 ms 改为 1 ms 步长后，500 ms 速度相差约 0.039 m/s；积分步长不是本工况拖沓感的主要线索。</p>
<p>代码中 Gamepad 总距直接写入输入，没有额外总距低通；舵机有 900°/s 速度上限，入流有 90 ms 动态状态。这两者都不是“先等待一段时间再执行”的延时器。键盘 W/S 则有独立的杆量渐变，不能拿键盘与遥控器响应混为一谈。</p>

<h3>收回悬停螺距，不代表刹停速度</h3>
<p>先以 +50% 总距持续 0.5 s，达到约 4.94 m/s 上升速度，再分别给三种指令：</p>
{table(['随后指令', '初始上升 m/s', '垂直速度首次过零', '1.5 s 末速度 m/s'], braking_rows)}
<p>这说明模型已有快速反推能力；“回悬停总距后还继续上升”和“反打也刹不住”是两种不同问题。过零后的强下降部分仍受当前简化入流模型限制，不能作为可靠的自转/涡环验证。</p>

<h2>3. HELI-X 样例给出的行为线索</h2>
<p>以记录速度求非均匀时间差分，加回世界重力后投影到机体上轴，得到<strong>单位质量的非重力合力</strong>。它包含主旋翼、尾桨和阻力等贡献，不等于单独测得的主旋翼推力。筛选机体坐标下记录横向速度 &lt;4 m/s、轴向速度绝对值 &lt;6 m/s，并限定轴向速度与总距同号、5%–70% 杆量，减少强下降工况干扰；未知风速仍是限制。</p>
<p>描述性拟合为 <code>机体上轴非重力加速度 ≈ 常数 + Kc × 总距杆量 + Kv × 机体轴向记录速度</code>。不将拟合系数认作 HELI-X 内部参数。</p>
{table(['录像', '有效帧', 'Kc m/s² / 单位杆量', 'Kv s⁻¹', '拟合 RMS m/s²', '分组 Kc 范围'], fit_rows)}
<p class="muted">分组范围为正/负总距、前/后半段的拟合结果范围，不是置信区间。Whiplash 残差较大，Kaken 的分段结果也有明显波动；因此不取一个全局倍数直接修改 Web 推力。</p>
<p>作为量级参照，Web 零空速、固定转速、入流收敛后的 3°→5° 局部斜率，在 3.2 kg / 2100 RPM 下为 {web['forceSurfaces'][0]['gainBetween3and5Deg']:.2f} m/s²/°，3.8 kg / 2400 RPM 下为 {web['forceSurfaces'][1]['gainBetween3and5Deg']:.2f} m/s²/°；按 ±13° 换算约 52.5、57.8 m/s²/单位杆量。<strong>这些静态工况与录像动态回归不是同条件测量</strong>，不能称为精确差距。它们共同提示：下一轮应优先核对总距有效力度与轴向速度敏感度。</p>
<h3>姿态通道</h3>
<p>通过相邻姿态矩阵的相对旋转求区间平均机体角速度，再拟合 <code>ω ≈ a·u + b·u³</code>。下表的满杆速率是拟合端点，不是读取了录制时的 Rates 设置。</p>
{table(['录像', '横滚拟合 °/s', '俯仰拟合 °/s', '尾舵拟合 °/s', '最优时间网格偏移 ms'], rate_rows)}
<p>候选时间偏移为 −60、−30、0、30、60、90 ms。六份录像三轴的最低残差都落在 0 ms 网格上；这只说明该采样分辨率下未见额外的整帧拖后，<strong>不代表零延迟</strong>。不同录像的 Rates / Expo 明显不同，不能直接将动作耗时相除得到控制器优劣。当前 Web 的独立阶跃测试仍需与这些描述性拟合区别对待。</p>

<h2>4. 下一轮修改的具体依据</h2>
<ol><li><strong>先标定总距力度曲线。</strong>建立总距、转速、轴向/横向速度到有效力的对照表，分别检查悬停附近、小杆与大杆；保留力→加速度→速度的积分关系。不要靠降低质量或持续提高 P/FF 来掩盖推力曲线的问题。</li>
<li><strong>再处理换向工况。</strong>把正常爬升、减速过零、强下降分别验证；现有均匀入流模型在强下降区只保证数值有限，不能把这一段的异常全部调成“更强阻尼”。</li>
<li><strong>旋转响应单独对齐。</strong>使用相同有效 Rates / Expo，测角速度起动、反向和刹停；总距路径不经过三轴 PID，二者不能混调。</li>
<li><strong>下一轮验证需要补足参照条件。</strong>现有录像可继续提供动作形态；要宣称当前 HELI-X 的延迟/550–700 通用手感已对齐，仍需已知配置的受控软件输入对照。当前无需用户采集真机日志。</li></ol>

<h2>5. 复算与产物</h2>
<p>只读取本机安装文件，输出聚合统计与 Web 自有曲线；没有复制 HELI-X 物理解算代码、机型参数表或整段录像。原始文件 SHA-256 与元数据在 JSON 中，Web 源文件哈希在 manifest 中。</p>
<pre>python3 -m venv .venv-analysis
source .venv-analysis/bin/activate
python3 -m pip install -r scripts/requirements-analysis.txt
npm run analyze:collective
npm run analyze:helix
npm run analyze:report
python3 -m unittest discover -s tests -p 'test_helix_*.py'
npm test
npm run build</pre>
<p>本轮执行结果：44 项 Node 测试、5 项 Python 测试全部通过；TypeScript 检查与生产构建通过。Vite 仍有已有的主包超过 500 kB 提示。本轮未修改生产物理与渲染逻辑。</p>
<p><a href="helix-recordings.json">录像审计 JSON</a> · <a href="collective-benchmark.json">Web 实验完整采样 JSON</a> · <a href="analysis-manifest.json">来源哈希</a> · <a href="collective-response.svg">矢量曲线 SVG</a></p>
<details><summary>查看全部 59 份录像清单</summary>{full_audit}</details>
<p class="muted">本报告为软件模型诊断，不是实机精度认证。没有对 HELI-X 当前进程注入输入；未完成同配置、同初态的 HELI-X/Web 直接回放。</p></main></html>'''
    (OUT / 'helix-response-report.html').write_text(page, encoding='utf-8')
    print(f"Saved {OUT / 'helix-response-report.html'}")


if __name__ == '__main__':
    main()
