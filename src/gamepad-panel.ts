import { CalibrationCapture, GamepadController, ProfileStore, channels, channelNames, defaultProfile, deviceKey, mapPad, profileErrors, type Channel, type PadProfile, type PadReading } from './gamepad.ts';

export class GamepadPanel {
  readonly dialog: HTMLDialogElement;
  private controller: GamepadController;
  private store: ProfileStore;
  private draft: PadProfile | null = null;
  private selectedIndex: number | null = null;
  private selectedKey = '';
  private capture: CalibrationCapture | null = null;
  private devicesSignature = '';
  private lastPaint = 0;
  private onOpen: () => void;
  private onClose: () => void;

  constructor(controller: GamepadController, store: ProfileStore, onOpen: () => void, onClose: () => void) {
    this.controller = controller; this.store = store; this.onOpen = onOpen; this.onClose = onClose;
    this.dialog = document.createElement('dialog');
    this.dialog.id = 'gamepad-dialog'; this.dialog.setAttribute('aria-labelledby', 'gamepad-title');
    this.dialog.innerHTML = `
      <div class="dialog-head"><span class="eyebrow">CONTROLLER SETUP</span><button id="gp-close" aria-label="关闭遥控器设置">×</button></div>
      <h2 id="gamepad-title">遥控器设置</h2><p class="gp-intro">默认 AETR 通道顺序。设置期间电机关闭，物理继续运行。</p>
      <label class="gp-device-label" for="gp-device">输入设备</label><div class="gp-device-row"><select id="gp-device"><option value="">等待设备连接</option></select><button id="gp-refresh">刷新</button></div>
      <p id="gp-device-info" class="gp-device-info"></p>
      <div id="gp-empty" class="gp-empty"><strong>尚未检测到遥控器或手柄</strong><p>将设备连接到电脑，点击此页面，再拨动摇杆或按一下手柄按钮。遥控器需工作在 USB 摇杆 / 游戏控制器模式。</p><p>部分浏览器需在设备上操作一次后才会显示。如果仍无设备，可在 Chrome 或 Edge 中打开此本地地址。</p></div>
      <div id="gp-content" hidden>
        <div class="gp-section-head"><h3>实时通道</h3><span>移动摇杆，观察对应通道</span></div><div id="gp-raw" class="gp-raw"></div><div id="gp-buttons" class="gp-buttons"></div>
        <div class="gp-section-head"><h3>通道分配</h3><button id="gp-defaults" class="link-button">恢复默认</button></div>
        <p class="gp-directions">CH1 副翼 · CH2 升降 · CH3 总距 · CH4 方向。拨杆检查方向，必要时反向。</p>
        <div class="gp-table-head"><span>功能</span><span>输入通道</span><span>反向</span><span>死区</span><span>校准后输出</span></div>
        <div id="gp-mappings"></div>
        <div class="gp-arming"><div class="gp-section-head"><h3>油门解锁</h3><output id="gp-arm-state">未分配</output></div><div class="gp-arm-fields"><label for="gp-arm-source">电机开关通道<select id="gp-arm-source"></select></label><label class="gp-arm-invert"><input id="gp-arm-invert" type="checkbox" />反向</label></div><p>高位启动、低位关闭。可选择独立轴通道或按钮；未分配时使用空格启停。</p></div>
        <div class="gp-calibration"><div class="gp-section-head"><h3>中位与行程校准</h3><span id="gp-cal-stage">未开始</span></div>
          <p id="gp-cal-hint">先将方向杆回中，总距杆也放到行程中间，然后记录中位。接着把已分配的各摇杆移动到正负两端。</p>
          <div class="gp-cal-actions"><button id="gp-center">1. 记录中位并采集行程</button><button id="gp-finish" disabled>2. 完成校准</button><button id="gp-cancel-cal" hidden>取消校准</button></div>
        </div>
      </div>
      <p id="gp-message" class="gp-message" role="status" aria-live="polite"></p>
      <div class="gp-footer"><button id="gp-disable">停用设备</button><button id="gp-save" class="primary" disabled>保存并启用</button></div>
      <p class="gp-footnote">设置按设备保存在此浏览器，刷新后自动恢复已保存的设备。解锁通道不参与摇杆中位校准。</p>
    `;
    document.body.appendChild(this.dialog);
    this.el('gp-close').onclick = () => this.dialog.close();
    this.dialog.addEventListener('close', () => { this.capture = null; this.onClose(); });
    this.el('gp-refresh').onclick = () => { this.controller.poll(); this.updateDevices(true); };
    this.el<HTMLSelectElement>('gp-device').onchange = e => this.select((e.target as HTMLSelectElement).value);
    this.el('gp-defaults').onclick = () => { const pad = this.selected(); if (pad) { this.capture = null; this.draft = defaultProfile(pad); this.buildRows(pad); this.message('已恢复默认分配；点击保存并启用后生效。'); this.updateCalibration(); } };
    this.el('gp-center').onclick = () => this.beginCalibration();
    this.el('gp-finish').onclick = () => this.finishCalibration();
    this.el('gp-cancel-cal').onclick = () => { this.capture = null; const pad = this.selected(); if (pad) this.buildRows(pad); this.updateCalibration(); this.message('已取消采集，原有校准数据保持不变。'); };
    this.el('gp-disable').onclick = () => { this.controller.disable(); this.message('已停用设备，恢复键盘 / 触控输入。电机保持关闭。'); this.updateAvailability(); };
    this.el('gp-save').onclick = () => this.save();
  }
  private el<T extends HTMLElement = HTMLElement>(id: string) { return this.dialog.querySelector<T>(`#${id}`)!; }
  private selected() { return this.controller.devices.find(p => p.index === this.selectedIndex && deviceKey(p) === this.selectedKey); }
  private message(text: string, error = false) { this.el('gp-message').textContent = text; this.el('gp-message').classList.toggle('error', error); }
  open() {
    if (this.dialog.open) return;
    this.onOpen(); this.capture = null; this.message(''); this.controller.poll();
    this.devicesSignature = ''; this.selectedIndex = null; this.selectedKey = ''; this.draft = null;
    this.updateDevices(true); this.dialog.showModal(); this.update(performance.now());
  }
  private select(value: string) {
    this.capture = null; this.message('');
    const pad = value === '' ? undefined : this.controller.devices.find(p => p.index === Number(value));
    this.selectedIndex = pad?.index ?? null; this.selectedKey = pad ? deviceKey(pad) : '';
    this.draft = pad ? this.controller.profileFor(pad) ?? this.store.load(pad) : null;
    this.el('gp-content').hidden = !pad; this.el('gp-empty').hidden = Boolean(pad);
    this.el('gp-device-info').textContent = pad ? `${pad.axes.length} 个轴 · ${pad.buttons.length} 个按钮 · ${pad.mapping === 'standard' ? '标准手柄布局' : 'AETR 默认通道顺序'}` : '';
    this.el<HTMLSelectElement>('gp-device').value = pad ? String(pad.index) : '';
    if (pad) {
      this.buildRows(pad);
      const raw = this.el('gp-raw'); raw.replaceChildren();
      pad.axes.forEach((_, index) => {
        const row = document.createElement('div'); row.className = 'gp-raw-channel';
        row.innerHTML = `<span>CH ${index + 1}<small>Axis ${index}</small></span><div class="gp-bar"><i></i><b></b></div><output>0.000</output>`;
        raw.appendChild(row);
      });
    }
    this.updateCalibration(); this.updateAvailability();
  }
  private updateDevices(force = false) {
    const signature = JSON.stringify([this.controller.error, this.controller.devices.map(p => [p.index, deviceKey(p)])]);
    if (!force && signature === this.devicesSignature) return;
    this.devicesSignature = signature;
    const selected = this.selected();
    const select = this.el<HTMLSelectElement>('gp-device');
    select.replaceChildren(new Option(this.controller.devices.length ? '选择输入设备' : '等待设备连接', ''));
    this.controller.devices.forEach(p => select.add(new Option(`${p.id} · #${p.index + 1}`, String(p.index))));
    if (selected) { select.value = String(selected.index); this.updateAvailability(); }
    else {
      const hadDevice = this.selectedIndex !== null;
      const preferred = hadDevice ? undefined : this.controller.devices.find(p => p.index === this.controller.activeIndex) ?? this.controller.devices[0];
      this.select(preferred ? String(preferred.index) : '');
      if (hadDevice) this.message('设备已断开。本次未保存的校准已取消，请重新选择设备。', true);
    }
    if (this.controller.error) this.message(this.controller.error, true);
  }
  private buildRows(pad: PadReading) {
    const container = this.el('gp-mappings'); container.replaceChildren();
    for (const channel of ['roll', 'pitch', 'collective', 'yaw'] as const) {
      const m = this.draft!.channels[channel];
      const row = document.createElement('div'); row.className = 'gp-mapping-row'; row.dataset.channel = channel;
      row.innerHTML = `<label class="gp-channel-name" for="gp-axis-${channel}">${channelNames[channel]}</label><select id="gp-axis-${channel}" aria-label="${channelNames[channel]}输入通道"></select><label class="gp-invert"><input id="gp-invert-${channel}" type="checkbox" aria-label="${channelNames[channel]}反向" />反向</label><label class="gp-deadzone"><input id="gp-deadzone-${channel}" type="number" min="0" max="20" step="0.5" aria-label="${channelNames[channel]}死区百分比" />%</label><div class="gp-output"><div class="gp-bar"><i></i><b></b></div><output>—</output></div><small class="gp-endpoints"></small>`;
      const select = row.querySelector('select')!;
      select.add(new Option('未分配', ''));
      pad.axes.forEach((_, i) => select.add(new Option(`CH ${i + 1} · Axis ${i}`, String(i))));
      select.value = m.axis === null ? '' : String(m.axis);
      const reverse = row.querySelector<HTMLInputElement>('input[type=checkbox]')!; reverse.checked = m.inverted;
      const zone = row.querySelector<HTMLInputElement>('input[type=number]')!; zone.value = String(Math.round(m.deadzone * 1000) / 10);
      select.onchange = () => {
        const current = this.draft!.channels[channel];
        Object.assign(current, { axis: select.value === '' ? null : Number(select.value), min: -1, center: 0, max: 1 });
        this.showEndpoints(row, channel); this.message('通道已更改，校准已恢复默认值。'); this.updateAvailability();
      };
      reverse.onchange = () => { this.draft!.channels[channel].inverted = reverse.checked; };
      zone.oninput = () => { this.draft!.channels[channel].deadzone = zone.value === '' ? NaN : Number(zone.value) / 100; this.message(''); this.updateAvailability(); };
      this.showEndpoints(row, channel); container.appendChild(row);
    }
    const arm = this.draft!.arm, select = this.el<HTMLSelectElement>('gp-arm-source');
    select.replaceChildren(new Option('未分配 · 空格启停', 'none'));
    pad.axes.forEach((_, i) => select.add(new Option(`CH ${i + 1} · Axis ${i}`, `axis:${i}`)));
    pad.buttons.forEach((_, i) => select.add(new Option(`按钮 ${i + 1}`, `button:${i}`)));
    select.value = arm.source === 'none' ? 'none' : `${arm.source}:${arm.index}`;
    const invert = this.el<HTMLInputElement>('gp-arm-invert'); invert.checked = arm.inverted;
    select.onchange = () => {
      const [source, index] = select.value.split(':');
      this.draft!.arm.source = source as typeof arm.source;
      this.draft!.arm.index = Number(index ?? 0); this.updateAvailability();
    };
    invert.onchange = () => { this.draft!.arm.inverted = invert.checked; };
  }
  private showEndpoints(row: HTMLElement, channel: Channel) {
    const m = this.draft!.channels[channel];
    row.querySelector('.gp-endpoints')!.textContent = m.axis === null ? '保留键盘 / 触控' : `最小 ${m.min.toFixed(3)} · 中位 ${m.center.toFixed(3)} · 最大 ${m.max.toFixed(3)}`;
  }
  private beginCalibration() {
    const pad = this.selected(); if (!pad || !this.draft) return;
    try {
      this.capture = new CalibrationCapture(pad, this.draft);
      this.message('中位已记录。现在将所有已分配摇杆缓慢走满两端，包括总距杆。');
    } catch (error) { this.message((error as Error).message, true); }
    this.updateCalibration();
  }
  private finishCalibration() {
    if (!this.capture) return;
    try {
      this.draft = this.capture.finish(); this.capture = null;
      const pad = this.selected(); if (pad) this.buildRows(pad);
      this.message('校准完成。检查反向与输出，再点击“保存并启用”。');
    } catch (error) { this.message((error as Error).message, true); }
    this.updateCalibration(); this.updateAvailability();
  }
  private updateCalibration() {
    const capturing = Boolean(this.capture);
    this.el<HTMLButtonElement>('gp-center').disabled = capturing || !this.draft;
    this.el<HTMLButtonElement>('gp-finish').disabled = !capturing;
    this.el('gp-cancel-cal').hidden = !capturing;
    this.el<HTMLSelectElement>('gp-device').disabled = capturing;
    this.el<HTMLButtonElement>('gp-defaults').disabled = capturing;
    this.el('gp-cal-stage').textContent = capturing ? '正在采集行程' : '可随时重新校准';
    this.dialog.querySelectorAll<HTMLInputElement | HTMLSelectElement>('#gp-mappings input, #gp-mappings select, #gp-arm-source, #gp-arm-invert').forEach(el => { el.disabled = capturing; });
    this.updateAvailability();
  }
  private updateAvailability() {
    const pad = this.selected();
    const errors = pad && this.draft ? profileErrors(this.draft, pad) : [];
    const save = this.el<HTMLButtonElement>('gp-save'); save.disabled = !pad || !this.draft || Boolean(this.capture) || errors.length > 0;
    save.title = errors.join('；');
    this.el<HTMLButtonElement>('gp-disable').disabled = !this.controller.active;
    if (errors.length && !this.capture) this.message(errors.join('；'), true);
  }
  private save() {
    const pad = this.selected(); if (!pad || !this.draft || this.capture) return;
    try {
      this.controller.enable(pad, this.draft);
      const saved = this.store.save(pad, this.draft);
      this.message(saved ? '已保存并启用。关闭设置后，由已分配通道控制飞机与电机。' : '设备已启用，但浏览器未允许保存设置；本次会话仍然有效。');
      this.updateAvailability();
    } catch (error) { this.message((error as Error).message, true); }
  }
  update(now: number) {
    if (!this.dialog.open) return;
    this.updateDevices();
    const pad = this.selected(); if (!pad || !this.draft) return;
    if (this.capture) {
      try { this.capture.observe(pad); }
      catch (error) { this.capture = null; this.buildRows(pad); this.updateCalibration(); this.message((error as Error).message, true); }
    }
    if (now - this.lastPaint < 50) return;
    this.lastPaint = now;
    const paint = (row: Element, value: number) => {
      const bounded = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
      (row.querySelector('.gp-bar b') as HTMLElement).style.left = `${(bounded + 1) * 50}%`;
      row.querySelector('output')!.textContent = Number.isFinite(value) ? `${value >= 0 ? '+' : ''}${value.toFixed(3)}` : '无效';
    };
    this.el('gp-raw').querySelectorAll('.gp-raw-channel').forEach((row, i) => paint(row, pad.axes[i]));
    const pressed = pad.buttons.map((b, i) => b.pressed || b.value > 0.1 ? `B${i + 1}` : '').filter(Boolean);
    this.el('gp-buttons').textContent = pressed.length ? `按下：${pressed.join(' · ')}` : '按钮：未按下';
    const output = mapPad(pad, this.draft);
    this.el('gp-arm-state').textContent = output.motor === undefined ? '未分配' : output.motor ? '解锁 / 电机开启' : '锁定 / 电机关闭';
    this.el('gp-mappings').querySelectorAll<HTMLElement>('.gp-mapping-row').forEach(row => {
      const channel = row.dataset.channel as Channel;
      paint(row.querySelector('.gp-output')!, output[channel] ?? 0);
      if (output[channel] === undefined) row.querySelector('output')!.textContent = '—';
      const sample = this.capture?.samples[channel];
      if (sample) row.querySelector('.gp-endpoints')!.textContent = `采集中 ${sample.min.toFixed(3)} ← ${sample.center.toFixed(3)} → ${sample.max.toFixed(3)}`;
    });
    if (this.capture) {
      const pending = this.capture.incomplete;
      this.el('gp-cal-stage').textContent = pending.length ? `待走满 ${pending.length} 个通道` : '行程已采集，可完成';
    }
  }
}
