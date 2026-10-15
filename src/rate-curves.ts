import { channels, type Channel, type MappedInput } from './gamepad.ts';
import { clamp, deg } from './physics/math.ts';
import { rateCommand, type RateProfile } from './physics/rates.ts';

type CurveProfile = { rates: RateProfile; pitch: number };
const plot = { left: 58, right: 536, rateTop: 26, rateBottom: 154, pitchTop: 204, pitchBottom: 250, width: 560, height: 282 };
const xAt = (stick: number) => plot.left + (stick + 1) / 2 * (plot.right - plot.left);
const yAt = (value: number, limit: number, top: number, bottom: number) => (top + bottom) / 2 - value / limit * (bottom - top) / 2;
const format = (value: number) => (Math.abs(value) < .05 ? 0 : value).toFixed(1);

/** Event-driven SVG preview. Uses the same Expo/rate function as the controller;
 * the collective channel is linear and deliberately does not receive rate Expo. */
export class RateCurves {
  private profile: CurveProfile | null = null;
  private rateLimit = 800;
  private hoverSample = 0;
  private input: MappedInput | null = null;
  private rendered = '';
  private root: HTMLElement;
  private svg: SVGSVGElement;

  constructor(root: HTMLElement) {
    this.root = root;
    root.innerHTML = `
      <div class="rate-chart-heading"><h3>通道响应</h3><span id="rate-preview-note">实时预览 · 应用后生效</span></div>
      <div class="rate-legend">
        ${channels.map(channel => `<div class="curve-${channel}"><span><i></i>${{ roll: '横滚', pitch: '俯仰', yaw: '尾舵', collective: '集体螺距' }[channel]}</span><output data-value="${channel}"></output><small>${channel === 'collective' ? '°' : '°/s'}</small><span class="rate-stick" data-stick="${channel}"></span></div>`).join('')}
      </div>
      <svg class="rate-plot" viewBox="0 0 ${plot.width} ${plot.height}" role="img" aria-labelledby="rate-plot-title rate-plot-description">
        <title id="rate-plot-title">速率与集体螺距曲线</title>
        <desc id="rate-plot-description"></desc>
        <g class="curve-grid"></g>
        <path class="curve-line curve-cyclic" data-curve="cyclic" />
        <path class="curve-line curve-yaw" data-curve="yaw" />
        <path class="curve-line curve-collective" data-curve="collective" />
        <g class="curve-probe" aria-hidden="true">
          ${channels.map(channel => `<g data-marker="${channel}" class="curve-${channel}">
            <line y1="${channel === 'collective' ? plot.pitchTop : plot.rateTop}" y2="${channel === 'collective' ? plot.pitchBottom : plot.rateBottom}" />
            ${channel === 'pitch' ? '<path data-dot d="M0,-7 L7,0 L0,7 L-7,0 Z" />' : `<circle data-dot r="${channel === 'roll' ? 5 : 3}" />`}
          </g>`).join('')}
        </g>
      </svg>
      <div class="rate-input-source"><span id="rate-input-source" role="status"></span><span id="rate-input-hint"></span></div>
      <p class="rate-preview-error" role="status" hidden>请输入有效范围内的参数以预览曲线。</p>`;
    this.svg = root.querySelector('svg')!;
    // Mouse hover and touch taps inspect both plots at the same stick position.
    // Touch dragging remains available for scrolling the settings panel.
    const inspect = (event: PointerEvent) => {
      if (!this.profile) return;
      const bounds = this.svg.getBoundingClientRect();
      if (!bounds.width) return;
      const x = (event.clientX - bounds.left) / bounds.width * plot.width;
      this.hoverSample = clamp((x - plot.left) / (plot.right - plot.left) * 2 - 1, -1, 1);
      this.updateSample();
    };
    this.svg.onpointermove = event => { if (event.pointerType === 'mouse') inspect(event); };
    this.svg.onpointerdown = inspect;
  }
  /** The controller has already applied channel mapping, reversal and calibration.
   * A connected radio owns the preview even with centered sticks or motors off. */
  updateInput(input: MappedInput | null) {
    this.input = input;
    this.updateSample();
  }
  update(profile: CurveProfile | null) {
    this.profile = profile;
    this.rendered = '';
    this.root.classList.toggle('is-invalid', !profile);
    this.root.querySelector<HTMLElement>('.rate-preview-error')!.hidden = Boolean(profile);
    this.root.querySelector<HTMLElement>('#rate-preview-note')!.hidden = !profile;
    this.root.querySelector<HTMLElement>('.rate-input-source')!.hidden = !profile;
    if (!profile) {
      this.root.querySelectorAll('output[data-value]').forEach(output => { output.textContent = '—'; });
      this.root.querySelectorAll('[data-stick]').forEach(output => { output.textContent = '—'; });
      this.svg.querySelector('desc')!.textContent = '参数无效，曲线预览不可用。';
      return;
    }
    this.rateLimit = Math.max(200, Math.ceil(Math.max(profile.rates.cyclic, profile.rates.yaw) / 200) * 200);
    const line = (x1: number, y1: number, x2: number, y2: number, zero = false) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="${zero ? 'curve-zero' : ''}" />`;
    const label = (x: number, y: number, text: string, anchor = 'end', cls = '') => `<text x="${x}" y="${y}" text-anchor="${anchor}" class="${cls}">${text}</text>`;
    let grid = label(plot.left, 14, '角速度 / °/s', 'start', 'curve-axis-title') + label(plot.left, 188, '集体螺距 / °', 'start', 'curve-axis-title');
    for (const s of [-1, -.5, 0, .5, 1]) {
      const x = xAt(s), y = yAt(s, 1, plot.rateTop, plot.rateBottom);
      grid += line(x, plot.rateTop, x, plot.rateBottom, s === 0) + line(x, plot.pitchTop, x, plot.pitchBottom, s === 0);
      grid += line(plot.left, y, plot.right, y, s === 0) + label(plot.left - 10, y + 4, String(s * this.rateLimit));
      grid += label(x, 274, `${s * 100}%`, 'middle');
    }
    // Fixed pitch scale makes an endpoint change visible instead of rescaling it away.
    for (const s of [-1, 0, 1]) {
      const y = yAt(s, 1, plot.pitchTop, plot.pitchBottom);
      grid += line(plot.left, y, plot.right, y, s === 0) + label(plot.left - 10, y + 4, String(s * 18));
    }
    this.svg.querySelector('.curve-grid')!.innerHTML = grid;
    for (const channel of ['cyclic', 'yaw', 'collective'] as const) {
      const path = Array.from({ length: 101 }, (_, i) => {
        const stick = i / 50 - 1;
        const y = channel === 'collective'
          ? yAt(stick * profile.pitch, 18, plot.pitchTop, plot.pitchBottom)
          : yAt(deg(rateCommand(stick, profile.rates[channel], profile.rates.expo)), this.rateLimit, plot.rateTop, plot.rateBottom);
        return `${i ? 'L' : 'M'}${xAt(stick).toFixed(2)},${y.toFixed(2)}`;
      }).join(' ');
      this.svg.querySelector(`[data-curve="${channel}"]`)!.setAttribute('d', path);
    }
    this.svg.querySelector('desc')!.textContent = `横轴为杆量 −100% 至 +100%。横滚和俯仰满杆 ${profile.rates.cyclic} 度每秒，尾舵满杆 ${profile.rates.yaw} 度每秒，常规 Expo ${Math.round(profile.rates.expo * 100)}%。下图集体螺距线性变化至正负 ${profile.pitch} 度，不受 Expo 影响。`;
    this.updateSample();
  }
  private updateSample() {
    if (!this.profile) return;
    const sticks = channels.map(channel => {
      const value = this.input === null ? this.hoverSample : this.input[channel];
      return value !== undefined && Number.isFinite(value) ? clamp(value, -1, 1) : null;
    });
    // Update only the probes/readouts when input changes; static curves never
    // rebuild in the frame loop. Hidden tabs are not updated by AircraftPanel.
    const signature = `${this.input !== null}:${sticks.join(',')}`;
    if (signature === this.rendered) return;
    this.rendered = signature;
    this.root.dataset.inputSource = this.input === null ? 'mouse' : 'gamepad';
    const source = this.input === null ? '鼠标预览' : '遥控器实时输入';
    const hint = this.input === null ? '悬浮曲线查看输出' : '已校准杆量 · 遥控器优先';
    const sourceEl = this.root.querySelector('#rate-input-source')!;
    const hintEl = this.root.querySelector('#rate-input-hint')!;
    if (sourceEl.textContent !== source) sourceEl.textContent = source;
    if (hintEl.textContent !== hint) hintEl.textContent = hint;
    channels.forEach((channel: Channel, index) => {
      const stick = sticks[index];
      const marker = this.svg.querySelector<SVGGElement>(`[data-marker="${channel}"]`)!;
      marker.style.display = stick === null ? 'none' : '';
      const output = this.root.querySelector(`[data-value="${channel}"]`)!;
      const inputLabel = this.root.querySelector(`[data-stick="${channel}"]`)!;
      if (stick === null) { output.textContent = '—'; inputLabel.textContent = '未分配'; return; }
      const p = this.profile!, collective = channel === 'collective';
      const value = collective ? stick * p.pitch
        : deg(rateCommand(stick, channel === 'yaw' ? p.rates.yaw : p.rates.cyclic, p.rates.expo));
      output.textContent = format(value);
      const percent = Math.round(stick * 100);
      inputLabel.textContent = `杆量 ${percent > 0 ? '+' : ''}${percent}%`;
      const x = xAt(stick), y = collective ? yAt(value, 18, plot.pitchTop, plot.pitchBottom)
        : yAt(value, this.rateLimit, plot.rateTop, plot.rateBottom);
      const line = marker.querySelector('line')!;
      line.setAttribute('x1', String(x)); line.setAttribute('x2', String(x));
      marker.querySelector('[data-dot]')!.setAttribute('transform', `translate(${x},${y})`);
    });
  }
}
