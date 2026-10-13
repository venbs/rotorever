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
      <header class="dialog-head gp-head"><div><span class="eyebrow">CONTROLLER</span><h2 id="gamepad-title">遥控器设置</h2></div><button id="gp-close" aria-label="关闭遥控器设置">×</button></header>
      <div class="gp-body">
        <label class="gp-device-label" for="gp-device">输入设备</label><select id="gp-device"><option value="">等待设备连接</option></select>
        <p id="gp-connection" class="gp-intro"></p>
        <div id="gp-empty" class="gp-empty"><strong>连接 USB 遥控器，即可开始</strong><p>选择 HID / 游戏控制器模式，点击页面并拨动摇杆。识别后自动使用 AETR，无需保存即可飞行。</p></div>
        <div id="gp-content" hidden>
          <div class="gp-table-head"><span>功能</span><span>通道</span><span>反向</span><span>输出</span></div>
          <div id="gp-mappings"></div>
          <div class="gp-arming">
            <div class="gp-section-head"><h3>电机解锁</h3><output id="gp-arm-state">未分配</output></div>
            <div class="gp-arm-fields"><select id="gp-arm-source" aria-label="电机开关通道"></select><label class="gp-arm-invert"><input id="gp-arm-invert" type="checkbox" />反向</label></div>
            <p id="gp-arm-hint">默认 CH6 · 高位启动，低位关闭。</p>
          </div>
          <details id="gp-advanced" class="gp-advanced"><summary>校准与更多设置</summary>
            <div class="gp-calibration"><div class="gp-section-head"><h3>中位与行程</h3><span id="gp-cal-stage"></span></div>
              <p>所有摇杆放到中间，记录中位；再将各杆走满正负两端，完成校准。</p>
              <div class="gp-cal-actions"><button id="gp-center">1. 记录中位</button><button id="gp-finish" disabled>2. 完成校准</button><button id="gp-cancel-cal" hidden>取消校准</button></div>
            </div>
            <div class="gp-section-head"><h3>摇杆死区</h3><span>百分比</span></div><div id="gp-deadzones" class="gp-deadzones"></div>
            <div class="gp-section-head"><h3>原始通道</h3><span>用于检查输入</span></div><div id="gp-raw" class="gp-raw"></div><div id="gp-buttons" class="gp-buttons"></div>
            <button id="gp-defaults" class="link-button">恢复 AETR / CH6 默认设置</button>
          </details>
        </div>
      </div>
      <footer class="gp-footer"><p id="gp-message" class="gp-message" role="status" aria-live="polite">连接后自动生效，修改后保存。</p><button id="gp-save" class="primary" disabled>保存设置</button></footer>
    `;
    document.body.appendChild(this.dialog);
    this.el('gp-close').onclick = () => this.dialog.close();
    this.dialog.addEventListener('close', () => { this.capture = null; this.onClose(); });
    this.el<HTMLSelectElement>('gp-device').onchange = e => this.select((e.target as HTMLSelectElement).value, true);
    this.el('gp-defaults').onclick = () => {
      const pad = this.selected();
      if (pad) { this.capture = null; this.draft = defaultProfile(pad); this.buildRows(pad); this.changed(); this.updateCalibration(); }
    };
    this.el('gp-center').onclick = () => this.beginCalibration();
    this.el('gp-finish').onclick = () => this.finishCalibration();
    this.el('gp-cancel-cal').onclick = () => { this.capture = null; this.updateCalibration(); this.message('已取消采集，原有校准保持不变。'); };
    this.el('gp-save').onclick = () => this.save();
  }
  private el<T extends HTMLElement = HTMLElement>(id: string) { return this.dialog.querySelector<T>(`#${id}`)!; }
  private selected() { return this.controller.devices.find(p => p.index === this.selectedIndex && deviceKey(p) === this.selectedKey); }
  private message(text: string, error = false) { this.el('gp-message').textContent = text; this.el('gp-message').classList.toggle('error', error); }
  private changed() { this.message('更改尚未保存。'); this.updateAvailability(); }
  open() {
    if (this.dialog.open) return;
    this.onOpen(); this.capture = null; this.message('连接后自动生效，修改后保存。'); this.controller.poll();
    this.el<HTMLDetailsElement>('gp-advanced').open = false;
    this.devicesSignature = ''; this.selectedIndex = null; this.selectedKey = ''; this.draft = null;
    this.updateDevices(true); this.dialog.showModal();
    this.dialog.querySelector('.gp-body')!.scrollTop = 0;
    this.update(performance.now());
  }
  private select(value: string, activate = false) {
    this.capture = null;
    const pad = value === '' ? undefined : this.controller.devices.find(p => p.index === Number(value));
    this.selectedIndex = pad?.index ?? null; this.selectedKey = pad ? deviceKey(pad) : '';
    this.draft = pad ? this.controller.profileFor(pad) ?? this.store.load(pad) : null;
    this.el('gp-content').hidden = !pad; this.el('gp-empty').hidden = Boolean(pad);
    this.el<HTMLSelectElement>('gp-device').value = pad ? String(pad.index) : '';
    if (activate) {
      if (pad && this.draft) {
        try { this.controller.enable(pad, this.draft); this.message('已连接，关闭设置即可飞行。'); }
        catch (error) { this.message((error as Error).message, true); }
      } else { this.controller.disable(); this.message('已切换到键盘 / 触控。'); }
    }
    if (pad) {
      this.buildRows(pad);
      const raw = this.el('gp-raw'); raw.replaceChildren();
      pad.axes.forEach((_, index) => {
        const row = document.createElement('div'); row.className = 'gp-raw-channel';
        row.innerHTML = `<span>CH${index + 1}</span><div class="gp-bar"><i></i><b></b></div><output>0%</output>`;
        raw.appendChild(row);
      });
    }
    this.updateCalibration(); this.updateAvailability();
  }
  private updateDevices(force = false) {
    const signature = JSON.stringify([this.controller.error, this.controller.activeIndex, this.controller.devices.map(p => [p.index, deviceKey(p)])]);
    if (!force && signature === this.devicesSignature) return;
    this.devicesSignature = signature;
    const selected = this.selected();
    const select = this.el<HTMLSelectElement>('gp-device');
    select.replaceChildren(new Option(this.controller.devices.length ? '键盘 / 触控' : '等待设备连接', ''));
    this.controller.devices.forEach(p => select.add(new Option(p.id, String(p.index))));
    if (selected) { select.value = String(selected.index); this.updateAvailability(); }
    else {
      const hadDevice = this.selectedIndex !== null;
      const active = this.controller.devices.find(p => p.index === this.controller.activeIndex);
      this.select(active ? String(active.index) : '');
      if (hadDevice) this.message('设备已断开，重连后自动恢复；未保存的修改已取消。', true);
      else if (active) this.message('已连接，关闭设置即可飞行。');
    }
    if (this.controller.error) this.message(this.controller.error, true);
  }
  private buildRows(pad: PadReading) {
    const container = this.el('gp-mappings'), deadzones = this.el('gp-deadzones'); container.replaceChildren(); deadzones.replaceChildren();
    for (const channel of ['roll', 'pitch', 'collective', 'yaw'] as const) {
      const m = this.draft!.channels[channel];
      const row = document.createElement('div'); row.className = 'gp-mapping-row'; row.dataset.channel = channel;
      row.innerHTML = `<label class="gp-channel-name" for="gp-axis-${channel}">${channelNames[channel]}</label><select id="gp-axis-${channel}" aria-label="${channelNames[channel]}输入通道"></select><label class="gp-invert"><input id="gp-invert-${channel}" type="checkbox" aria-label="${channelNames[channel]}反向" /><span>反向</span></label><div class="gp-output"><div class="gp-bar"><i></i><b></b></div><output>—</output></div>`;
      const select = row.querySelector('select')!;
      select.add(new Option('未分配', ''));
      pad.axes.forEach((_, i) => select.add(new Option(`CH${i + 1}`, String(i))));
      select.value = m.axis === null ? '' : String(m.axis);
      const reverse = row.querySelector<HTMLInputElement>('input[type=checkbox]')!; reverse.checked = m.inverted;
      select.onchange = () => {
        Object.assign(this.draft!.channels[channel], { axis: select.value === '' ? null : Number(select.value), min: -1, center: 0, max: 1 });
        this.changed();
      };
      reverse.onchange = () => { this.draft!.channels[channel].inverted = reverse.checked; this.changed(); };
      container.appendChild(row);
      const label = document.createElement('label'); label.className = 'gp-deadzone';
      label.innerHTML = `<span>${channelNames[channel]}</span><input id="gp-deadzone-${channel}" type="number" min="0" max="20" step="0.5" aria-label="${channelNames[channel]}死区百分比" />`;
      const zone = label.querySelector('input')!; zone.value = String(Math.round(m.deadzone * 1000) / 10);
      zone.oninput = () => { this.draft!.channels[channel].deadzone = zone.value === '' ? NaN : Number(zone.value) / 100; this.changed(); };
      deadzones.appendChild(label);
    }
    const arm = this.draft!.arm, select = this.el<HTMLSelectElement>('gp-arm-source');
    select.replaceChildren(new Option('空格启停', 'none'));
    pad.axes.forEach((_, i) => select.add(new Option(`CH${i + 1}${i === 5 ? ' · 默认' : ''}`, `axis:${i}`)));
    pad.buttons.forEach((_, i) => select.add(new Option(`按钮 ${i + 1}`, `button:${i}`)));
    select.value = arm.source === 'none' ? 'none' : `${arm.source}:${arm.index}`;
    const invert = this.el<HTMLInputElement>('gp-arm-invert'); invert.checked = arm.inverted;
    select.onchange = () => {
      const [source, index] = select.value.split(':');
      this.draft!.arm.source = source as typeof arm.source;
      this.draft!.arm.index = Number(index ?? 0); this.changed();
    };
    invert.onchange = () => { this.draft!.arm.inverted = invert.checked; this.changed(); };
    this.el('gp-arm-hint').textContent = pad.axes.length >= 6 ? '默认 CH6 · 高位启动，低位关闭。' : '设备没有 CH6，可选择其他开关；未分配时用空格启停。';
  }
  private beginCalibration() {
    const pad = this.selected(); if (!pad || !this.draft) return;
    try {
      this.capture = new CalibrationCapture(pad, this.draft);
      this.message('中位已记录，将各摇杆走满正负两端，包括总距杆。');
    } catch (error) { this.message((error as Error).message, true); }
    this.updateCalibration();
  }
  private finishCalibration() {
    if (!this.capture) return;
    try {
      this.draft = this.capture.finish(); this.capture = null;
      const pad = this.selected(); if (pad) this.buildRows(pad);
      this.message('校准完成，保存后生效。');
    } catch (error) { this.message((error as Error).message, true); }
    this.updateCalibration();
  }
  private updateCalibration() {
    const capturing = Boolean(this.capture);
    this.el<HTMLButtonElement>('gp-center').disabled = capturing || !this.draft;
    this.el<HTMLButtonElement>('gp-finish').disabled = !capturing;
    this.el('gp-cancel-cal').hidden = !capturing;
    this.el<HTMLSelectElement>('gp-device').disabled = capturing;
    this.el<HTMLButtonElement>('gp-defaults').disabled = capturing;
    this.el('gp-cal-stage').textContent = capturing ? '正在采集' : '';
    this.dialog.querySelectorAll<HTMLInputElement | HTMLSelectElement>('#gp-mappings input, #gp-mappings select, #gp-deadzones input, #gp-arm-source, #gp-arm-invert').forEach(el => { el.disabled = capturing; });
    this.updateAvailability();
  }
  private updateAvailability() {
    const pad = this.selected();
    const errors = pad && this.draft ? profileErrors(this.draft, pad) : [];
    const save = this.el<HTMLButtonElement>('gp-save'); save.disabled = !pad || !this.draft || Boolean(this.capture) || errors.length > 0;
    save.title = errors.join('；');
    this.el('gp-connection').textContent = pad && this.controller.profileFor(pad)
      ? '已连接 · 设置期间电机关闭，关闭后即可飞行。'
      : this.controller.devices.length ? '选择遥控器即可连接，或使用键盘 / 触控。' : '识别后自动连接 · 默认 AETR / CH6。';
    if (errors.length && !this.capture) this.message(errors.join('；'), true);
  }
  private save() {
    const pad = this.selected(); if (!pad || !this.draft || this.capture) return;
    try {
      this.controller.enable(pad, this.draft);
      const saved = this.store.save(pad, this.draft);
      this.message(saved ? '已保存，关闭设置即可飞行。' : '已应用；浏览器不允许保存，当前会话仍有效。');
      this.updateAvailability();
    } catch (error) { this.message((error as Error).message, true); }
  }
  update(now: number) {
    if (!this.dialog.open) return;
    this.updateDevices();
    const pad = this.selected(); if (!pad || !this.draft) return;
    if (this.capture) {
      try { this.capture.observe(pad); }
      catch (error) { this.capture = null; this.updateCalibration(); this.message((error as Error).message, true); }
    }
    if (now - this.lastPaint < 50) return;
    this.lastPaint = now;
    const paint = (row: Element, value: number) => {
      const bounded = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
      (row.querySelector('.gp-bar b') as HTMLElement).style.left = `${(bounded + 1) * 50}%`;
      row.querySelector('output')!.textContent = Number.isFinite(value) ? `${Math.round(bounded * 100)}%` : '无效';
    };
    if (this.el<HTMLDetailsElement>('gp-advanced').open) {
      this.el('gp-raw').querySelectorAll('.gp-raw-channel').forEach((row, i) => paint(row, pad.axes[i]));
      const pressed = pad.buttons.map((b, i) => b.pressed || b.value > 0.1 ? `B${i + 1}` : '').filter(Boolean);
      this.el('gp-buttons').textContent = pressed.length ? `按下：${pressed.join(' · ')}` : '';
    }
    const output = mapPad(pad, this.draft);
    this.el('gp-arm-state').textContent = output.motor === undefined ? '空格启停' : output.motor ? '电机开启' : '电机关闭';
    this.el('gp-mappings').querySelectorAll<HTMLElement>('.gp-mapping-row').forEach(row => {
      const channel = row.dataset.channel as Channel;
      paint(row.querySelector('.gp-output')!, output[channel] ?? 0);
      if (output[channel] === undefined) row.querySelector('output')!.textContent = '—';
    });
    if (this.capture) {
      const pending = this.capture.incomplete;
      this.el('gp-cal-stage').textContent = pending.length ? `待走满 ${pending.length} 个通道` : '可完成校准';
    }
  }
}
