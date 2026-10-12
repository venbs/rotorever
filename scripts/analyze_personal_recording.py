"""Read a personal HELI-X recording and generate a reproducible comparison report.

No installed HELI-X files, simulator parameters or browser settings are changed.
The Web rotor benchmark prescribes recorded velocity; it is not free flight.
"""
from pathlib import Path
import argparse
import base64
from datetime import datetime
import hashlib
import html
import json
import os
import shlex
import subprocess
import tempfile
import numpy as np
from helix_recording import read_recording
from analyze_helix import arrays, audit, body_rate_intervals, rate_fits

ROOT = Path(__file__).resolve().parents[1]
GRAVITY = 9.80665


def projected_acceleration(velocity, rotation, time):
    acceleration = np.gradient(velocity, time, axis=0)
    acceleration[:, 1] += GRAVITY
    return np.einsum('ni,ni->n', acceleration, rotation[:, :, 1])


def point_mask(interval_good):
    """A centered derivative needs both neighboring kinematic intervals."""
    mask = np.zeros(len(interval_good) + 1, dtype=bool)
    mask[1:-1] = interval_good[:-1] & interval_good[1:]
    return mask


def fit_force(collective, axial_speed, force_per_mass, mask):
    x = np.column_stack((np.ones(len(collective)), collective, axial_speed))
    if mask.sum() < 30 or np.linalg.matrix_rank(x[mask]) != 3:
        return {'samples': int(mask.sum()), 'usable': False}
    c = np.linalg.lstsq(x[mask], force_per_mass[mask], rcond=None)[0]
    error = force_per_mass[mask] - x[mask] @ c
    return {'samples': int(mask.sum()), 'usable': True, 'offset': float(c[0]),
            'collectiveGain': float(c[1]), 'axialVelocityGain': float(c[2]),
            'rmsAcceleration': float(np.sqrt(np.mean(error ** 2)))}


def plateau_rates(controls, omega, t, good):
    midpoint = (t[:-1] + t[1:]) / 2
    result = {}
    for label, axis, channel in [('roll', 0, 2), ('pitch', 2, 1), ('yaw', 1, 3)]:
        u = controls[:, channel]
        stable = good & (abs(u[:-1]) > .98) & (abs(u[1:]) > .98) & (u[:-1] * u[1:] > 0)
        for lag in [.03, .06, .09, .12]:
            stable &= np.interp(midpoint - lag, t, u) * np.sign(u[:-1]) > .98
        values = np.abs(np.degrees(omega[stable, axis]))
        result[label] = {'samples': int(stable.sum()),
                         'p5MedianP95DegPerSecond': np.percentile(values, [5, 50, 95]).tolist() if len(values) else None}
    return result


def table(headers, rows):
    def cells(values, tag):
        return ''.join(f'<{tag}>{html.escape(str(v))}</{tag}>' for v in values)
    return '<div class="scroll"><table><thead><tr>' + cells(headers, 'th') + '</tr></thead><tbody>' + ''.join('<tr>' + cells(row, 'td') + '</tr>' for row in rows) + '</tbody></table></div>'


def render(out, report, t, controls, rotation, position, velocity, normal, body_velocity, fits_mask, predicted):
    os.environ.setdefault('MPLCONFIGDIR', '/tmp/heli-analysis-matplotlib')
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    plt.rcParams.update({'font.family': 'DejaVu Sans', 'font.size': 10,
                         'axes.spines.top': False, 'axes.spines.right': False,
                         'axes.grid': True, 'grid.alpha': .17})
    colors = ['#156cff', '#658090']
    fig, axes = plt.subplots(3, 1, figsize=(12, 8.5), sharex=True, layout='constrained')
    axes[0].plot(t, controls[:, 0], color=colors[0], label='Recorded collective')
    axes[0].plot(t, rotation[:, 1, 1], color=colors[1], alpha=.6, label='Body-up / world-up dot product')
    axes[0].set(ylabel='Normalized value', title='Full recording: collective, orientation and motion')
    axes[0].legend(loc='lower left', ncol=2, fontsize=8)
    axes[1].plot(t, position[:, 1], label='Height', color=colors[0])
    axes[1].plot(t, velocity[:, 1], label='Vertical velocity', color=colors[1])
    axes[1].set(ylabel='Height (m) / speed (m/s)')
    axes[1].legend(loc='lower left', ncol=2, fontsize=8)
    for i, label in enumerate(['Pitch', 'Roll', 'Yaw']):
        axes[2].plot(t, controls[:, i + 1], lw=.9, label=label, alpha=.85)
    axes[2].set(xlabel='Recording time (s)', ylabel='Recorded control')
    axes[2].legend(loc='lower left', ncol=3, fontsize=8)
    for ax in axes:
        ax.axvspan(0, 16, color='#156cff', alpha=.04)
        for jump in report['discontinuitiesSeconds']:
            ax.axvline(jump, color='#b04545', ls='--', lw=1)
        ax.set_xlim(0, t[-1])
    fig.savefig(out / 'overview.png', dpi=160)
    plt.close(fig)

    fig, axes = plt.subplots(3, 1, figsize=(11, 8.2), sharex=True, layout='constrained')
    selection = (t >= 9.25) & (t <= 10.65)
    tt = t[selection]
    axes[0].plot(tt, controls[selection, 0], '.-', color='#156cff', ms=3)
    axes[0].set(ylabel='Recorded collective', title='Upright collective reversal: recorded motion vs prescribed-airflow rotor bench')
    axes[1].plot(tt, normal[selection], '.-', color='#142238', ms=3, lw=2, label='HELI-X: derived net non-gravity force / mass')
    for case, color in zip(predicted[:2], colors):
        axes[1].plot(tt, np.asarray(case['acceleration'])[selection], color=color, label=f"Web: {case['mass']} kg / {case['rpm']} RPM / 13 deg")
    axes[1].set(ylabel='Body-up force / mass (m/s²)')
    axes[1].legend(fontsize=8, loc='lower left')
    axes[2].plot(tt, velocity[selection, 1], color='#142238', label='HELI-X recorded vertical velocity')
    axes[2].plot(tt, position[selection, 1], color='#156cff', ls='--', label='HELI-X recorded height')
    axes[2].set(ylabel='Speed (m/s) / height (m)', xlabel='Recording time (s)')
    axes[2].legend(fontsize=8)
    for ax in axes:
        ax.axhline(0, color='#8795a5', lw=.7)
    fig.savefig(out / 'collective-comparison.png', dpi=170)
    fig.savefig(out / 'collective-comparison.svg')
    plt.close(fig)

    recorded = report['forceFits']['alignedFlow']['helix']
    comparison = report['forceFits']['alignedFlow']
    split = report['collectiveSplits']
    comparison_rows = [['HELI-X 录像', recorded['samples'], f"{recorded['collectiveGain']:.2f}", f"{recorded['axialVelocityGain']:.2f}", f"{recorded['rmsAcceleration']:.2f}"]]
    for case in predicted:
        c = comparison[case['name']]
        comparison_rows.append([case['name'], c['samples'], f"{c['collectiveGain']:.2f}", f"{c['axialVelocityGain']:.2f}", f"{c['rmsAcceleration']:.2f}"])
    rate_rows = [[{'roll': '横滚', 'pitch': '俯仰', 'yaw': '尾舵'}[axis], result['samples'], f"{result['p5MedianP95DegPerSecond'][1]:.1f}", '–'.join(f'{v:.1f}' for v in [result['p5MedianP95DegPerSecond'][0], result['p5MedianP95DegPerSecond'][2]])] for axis, result in report['plateauRates'].items()]
    split_rows = [[label, f['samples'], f"{f['collectiveGain']:.2f}"] for label, f in split.items() if f['usable']]
    def embed(name):
        data = base64.b64encode((out / name).read_bytes()).decode()
        return f'<img src="data:image/png;base64,{data}" alt="{html.escape(name)}">'
    a = report['audit']
    jump_description = '、'.join(f'{v:.2f} s' for v in report['discontinuitiesSeconds']) or '无'
    page = f'''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tron5.5 test · 飞行响应分析</title><style>
*{{box-sizing:border-box}}body{{margin:0;background:#f2f5fa;color:#142238;font:15px/1.8 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}}main{{max-width:1100px;margin:32px auto;padding:38px;background:#fff;border-top:4px solid #156cff}}h1{{font-size:30px;line-height:1.4}}h2{{margin-top:36px;font-size:21px}}.label{{color:#156cff;font:12px/1.5 monospace;letter-spacing:2px}}.callout{{padding:16px 20px;background:#edf4ff;border-left:3px solid #156cff}}img{{width:100%;height:auto;margin:18px 0}}.scroll{{overflow:auto}}table{{border-collapse:collapse;width:100%;font-size:13px}}td,th{{text-align:left;border-bottom:1px solid #dbe3ee;padding:10px;white-space:nowrap}}th{{background:#f5f8fc}}small{{color:#586a80}}code,pre{{font-size:12px;background:#f5f8fc}}pre{{padding:16px;white-space:pre-wrap;overflow-wrap:anywhere}}a{{color:#156cff}}@media(max-width:700px){{main{{margin:0;padding:22px 16px}}h1{{font-size:25px}}}}</style></head><body><main>
<div class="label">FLIGHT RESPONSE / PERSONAL RECORDING · 2026-10-11</div><h1>Tron5.5 test：总距力度与转动响应</h1>
<div class="callout"><strong>这份录像可用，已经能支持下一轮动力响应调整。</strong>当前版本、明确机型、重复总距脉冲和三轴满杆段都具备。当前最强线索是 Web 在指定工况下的总距有效力度偏低；不是需要继续盲目缩短输入滤波。33 Hz 仍不足以测定几毫秒的遥控器到屏幕延迟。</div>
<h2>1. 文件完整性与可用片段</h2>
<p>来源：{html.escape(a['file'])}；元数据为 2026-10-11、HELI-X revision {a['revision']}、Tron_55。共 <strong>{a['frames']:,} 帧 / {a['durationSeconds']:.2f} 秒</strong>，平均 {report['averageHz']:.2f} Hz；间隔中位 {a['sampleIntervalMs']['p50']:.2f} ms，最短 / 最长 {a['sampleIntervalMs']['min']:.2f} / {a['sampleIntervalMs']['max']:.2f} ms，没有超过 60 ms 的时间间隙。</p>
<p>位置与速度的 P95 一致性残差为 {a['positionVelocityResidualMps']['p95']:.3f} m/s；姿态矩阵最大正交误差 {a['orthogonalityMaxError']:.2e}。检测到的位置/姿态跳变时刻：{jump_description}。本段末尾的跳变符合复位特征；跳变及前后 0.18 s 排除。不是把复位尖峰当作真实加速度。</p>
<p>前 16 秒主要是正立总距脉冲，随后出现俯仰、横滚、尾舵满杆及复合动作。四个记录通道都覆盖 −1 到 +1。筛选后有 {report['validIntervals']} 个离地、连续运动区间用于姿态分析；总距同向流 / 低速子集为 {recorded['samples']} 个点。</p>
{embed('overview.png')}
<h2>2. 总距有效力度：同一杆量与速度历史下的比较</h2>
<p>从记录的世界速度求非均匀时间差分，加回重力，再投影到机体上轴，得到单位质量的非重力合力。它包含阻力等贡献，并不是独立的旋翼推力传感器。用 <code>aₙ ≈ b + Kc·总距杆量 + Kv·机体轴向速度</code> 描述局部行为。</p>
<p>给 Web 自有旋翼模型输入同一份总距和机体速度历史，保留原有桨距执行器及 90 ms 入流状态，用固定转速排除掉转；这是<strong>规定气流轨迹的旋翼实验，不是整机自由飞行回放</strong>。两组条件分别为 3.2 kg / 2100 RPM、3.8 kg / 2400 RPM，均 ±13°；不是读取了你浏览器或 HELI-X 录制时的全部配置。</p>
{table(['对象', '样本数', 'Kc：m/s² / 单位杆量', 'Kv：s⁻¹', '拟合残差 RMS：m/s²'], comparison_rows)}
<p>在同一子集中，HELI-X 的 Kc 约 <strong>{recorded['collectiveGain']:.1f}</strong>，Web 两组实验约 <strong>{comparison['default-ideal']['collectiveGain']:.1f} / {comparison['representative-ideal']['collectiveGain']:.1f}</strong>。这说明在这些工况下，相同杆量变化对应的有效力度较弱。也就是杆已经动了，但用于改变原有速度的力偏少，主观上可能像拖沓。</p>
<p><strong>不能直接把整个推力乘两倍。</strong>完整质量、RPM、桨距、风和飞控配置未随录像保存；这些是动态描述性回归，不是 HELI-X 内部参数。转速与桨距工作点、正负螺距、速度过零、悬停平衡和高空速都还要分别约束。Kv 的负值也不能单独称为“刹车阻尼”。</p>
{embed('collective-comparison.png')}
<p>上图展示 9.25–10.65 s 正立正负总距换向；黑线为从录像速度得到的非重力合力 / 质量，蓝灰线为两组 Web 旋翼实验。速度与高度只画 HELI-X 实测轨迹，避免将规定气流实验误呈现为 Web 的自由飞行轨迹。</p>
<h2>3. 换片段后，结论是否仍成立</h2>
{table(['HELI-X 子集', '样本数', 'Kc'], split_rows)}
<p>正负总距、前后半段以及初段正立脉冲都给出接近的总距增益，说明结果并非仅由一个大动作或末尾复位尖峰造成。分组差异不是置信区间，采样点也不独立。Web 子步长由最多 4 ms 降为 2 ms 后，有效区间预测加速度差的 RMS 为 {report['webStepSensitivityRms']:.3f} m/s²，远小于此处两个模拟器之间的差异。</p>
<h2>4. 旋转速度与时间分辨率</h2>
{table(['通道', '稳定满杆区间数', '实测中位 °/s', 'P5–P95 °/s'], rate_rows)}
<p>上述值来自连续保持至少约 120 ms、杆量绝对值 &gt;98% 的区间平均角速度，包含正负方向；是录像中的结果，不是读取的 Rates 设置。它们约为斜盘 284°/s、尾舵 546°/s，与 Web 目前常用的 350 / 620°/s 目标并不相同，因此不能仅按翻转快慢评价跟手程度。</p>
<p>在 −60、−30、0、30、60、90 ms 的时间偏移网格上，三轴描述性杆量—角速度拟合都在 0 ms 处残差最小。这表示未见额外的整帧滞后，<strong>不代表零延迟或小于某个确定毫秒数</strong>。记录的是模拟器控制通道，不是带 USB 接收时间的原始遥控器包。</p>
<h2>5. 对 Web 下一步的直接依据</h2>
<p>先处理<strong>总距 → 有效加速度曲线</strong>，保持悬停力平衡，分别验证正负桨距与轴向速度过零。随后在相同有效 Rates / Expo 下验证三轴起动、松杆与反向。总距路径不经过三轴 PIDFF；继续提高姿态 P / FF 不能替代这项动力标定。现有录像已经足够开始这轮工作，暂时不需要再录一遍。</p>
<p>本次仅做读取、分析和独立模型实验，未修改 Web 生产参数，也未再修改 HELI-X 程序。质量和 RPM 的实验条件不是“当前用户设置”；风未知；强下降均匀入流模型仍有适用边界；该结论不等于实机精度认证。</p>
<p><a href="summary.json">完整审计与拟合 JSON</a> · <a href="collective-comparison.svg">换向曲线 SVG</a> · <a href="manifest.json">来源与脚本哈希</a></p>
<details><summary>复算方法</summary><pre>PYTHONPATH=/tmp/heli-analysis-python /Users/bytedance/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 scripts/analyze_personal_recording.py --file {html.escape(shlex.quote(report['source']))} --out analysis/tron55-test</pre>
<p>筛选：相邻记录 10–50 ms，位置/速度一致性残差 &lt;1 m/s，单区间转角 &lt;90°，首尾高度 &gt;2 m；中心差分要求前后区间均有效。总距同向流子集进一步限制横向速度 &lt;4 m/s、轴向速度绝对值 &lt;6 m/s、轴向速度×总距 ≥0、5%–70% 总距。Web 假定无风、气流等于记录的机体速度；输入在记录点之间线性插值；忽略周期变距引起的桨盘倾斜，固定 RPM。</p></details>
</main></body></html>'''
    (out / 'report.html').write_text(page, encoding='utf-8')


def analyze(path, out):
    source_sha = hashlib.sha256(path.read_bytes()).hexdigest()
    recording = read_recording(path)
    r, rotation, t = arrays(recording)
    if len(t) < 100 or t[-1] < 20:
        raise ValueError('This report requires at least 20 s and 100 frames')
    t = t - t[0]
    dt = np.diff(t)
    position, velocity, controls = r[3][:, :3], r[4][:, :3], r[5][:, :4]
    omega, angle = body_rate_intervals(rotation, t)
    residual = np.linalg.norm(np.diff(position, axis=0) / dt[:, None] - (velocity[1:] + velocity[:-1]) / 2, axis=1)
    jumps = np.flatnonzero((residual > 1) | (angle > np.pi / 2))
    good = (dt > .01) & (dt < .05) & (residual < 1) & (angle < np.pi / 2) & (position[:-1, 1] > 2) & (position[1:, 1] > 2)
    for i in jumps:
        good &= (t[1:] < t[i] - .18) | (t[:-1] > t[i + 1] + .18)
    points = point_mask(good)
    normal = projected_acceleration(velocity, rotation, t)
    vb = np.einsum('nji,nj->ni', rotation, velocity)
    u = controls[:, 0]
    low_speed = points & (np.linalg.norm(vb[:, [0, 2]], axis=1) < 4) & (abs(vb[:, 1]) < 6)
    aligned = low_speed & (vb[:, 1] * u >= 0) & (abs(u) > .05) & (abs(u) < .7)
    masks = {'alignedFlow': aligned, 'lowSpeed': low_speed,
             'initialUprightPulses': points & (t < 16) & (rotation[:, 1, 1] > .98)}
    # Temporary interchange contains only fields consumed by our independent bench.
    with tempfile.TemporaryDirectory(prefix='heli-personal-analysis-') as work:
        bench_input, bench_output = Path(work) / 'input.json', Path(work) / 'output.json'
        bench_input.write_text(json.dumps({'samples': [{'t': float(time), 'collective': float(c), 'bodyVelocity': v.tolist()} for time, c, v in zip(t, u, vb)]}))
        subprocess.run(['node', '--experimental-strip-types', str(ROOT / 'scripts/recording-rotor-benchmark.ts'), str(bench_input), str(bench_output)], check=True, cwd=ROOT)
        bench = json.loads(bench_output.read_text())
    predicted = bench['cases']
    fits = {}
    for label, mask in masks.items():
        fits[label] = {'helix': fit_force(u, vb[:, 1], normal, mask)}
        for case in predicted:
            values = np.asarray(case['acceleration'])
            f = fits[label][case['name']] = fit_force(u, vb[:, 1], values, mask)
            f['rmsVsRecordedAcceleration'] = float(np.sqrt(np.mean((values[mask] - normal[mask]) ** 2)))
    splits = {}
    for label, subset in [('正总距 · 同向流', u > 0), ('负总距 · 同向流', u < 0),
                           ('前半段 · 同向流', t < t[-1] / 2), ('后半段 · 同向流', t >= t[-1] / 2)]:
        splits[label] = fit_force(u, vb[:, 1], normal, aligned & subset)
    splits['前 16 秒 · 正立脉冲'] = fits['initialUprightPulses']['helix']
    original = audit(path, path.parent)
    report = {'source': str(path), 'audit': original, 'averageHz': float((len(t) - 1) / t[-1]),
              'discontinuitiesSeconds': t[jumps].tolist(), 'validIntervals': int(good.sum()),
              'forceFits': fits, 'collectiveSplits': splits, 'plateauRates': plateau_rates(controls, omega, t, good),
              'rateFits': rate_fits(controls, omega, t, good), 'webConditions': bench['conditions'],
              'webCases': [{k: v for k, v in c.items() if k not in ('acceleration', 'wake', 'collectivePitch')} for c in predicted],
              'webStepSensitivityRms': float(np.sqrt(np.mean((np.asarray(predicted[1]['acceleration'])[points] - np.asarray(predicted[2]['acceleration'])[points]) ** 2))),
              'limits': ['Descriptive closed-loop fits, not causal parameter estimates or millisecond latency.',
                         'Recorded controls, not raw USB packets. Unknown complete tune/wind/flight-mode settings.',
                         'Web mass/RPM are explicit experiments, not recorded or current user settings.',
                         'Prescribed velocity with zero wind, fixed RPM and upright disc model is not full aircraft replay.'],
              'productionPhysicsChanged': False, 'helixApplicationChanged': False}
    if source_sha != hashlib.sha256(path.read_bytes()).hexdigest():
        raise RuntimeError('Recording changed during analysis; no report written')
    out.mkdir(parents=True, exist_ok=True)
    (out / 'summary.json').write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + '\n')
    render(out, report, t, controls, rotation, position, velocity, normal, vb, aligned, predicted)
    sources = [ROOT / 'scripts/analyze_personal_recording.py', ROOT / 'scripts/recording-rotor-benchmark.ts', ROOT / 'scripts/analyze_helix.py', ROOT / 'scripts/helix_recording.py', *sorted((ROOT / 'src/physics').glob('*.ts'))]
    manifest = {'createdAt': datetime.now().astimezone().isoformat(), 'source': str(path), 'sourceSha256': source_sha,
                'metadataSha256': hashlib.sha256(path.with_suffix('.xml').read_bytes()).hexdigest(),
                'scriptsAndPhysics': {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sources},
                'numpyVersion': np.__version__, 'productionPhysicsChanged': False, 'helixApplicationChanged': False}
    (out / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps({'frames': len(t), 'duration': t[-1], 'forceFits': fits['alignedFlow'], 'report': str(out / 'report.html')}, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--file', type=Path, required=True)
    parser.add_argument('--out', type=Path, default=ROOT / 'analysis/tron55-test')
    args = parser.parse_args()
    analyze(args.file, args.out)
