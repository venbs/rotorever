import { clamp } from './physics/math.ts';

export const channels = ['roll', 'pitch', 'yaw', 'collective'] as const;
export type Channel = typeof channels[number];
export const channelNames: Record<Channel, string> = { roll: '横滚 / 副翼', pitch: '俯仰 / 升降', yaw: '偏航 / 方向', collective: '总距' };
export interface PadReading {
  id: string; index: number; connected: boolean; mapping: string;
  axes: readonly number[]; buttons: readonly { value: number; pressed: boolean }[];
}
export interface AxisMapping {
  axis: number | null;
  inverted: boolean;
  deadzone: number;
  min: number; center: number; max: number;
}
export interface ArmMapping { source: 'none' | 'axis' | 'button'; index: number; inverted: boolean }
export interface PadProfile { version: 1; channels: Record<Channel, AxisMapping>; arm: ArmMapping }
export type MappedInput = Partial<Record<Channel, number>> & { motor?: boolean };
export interface ProfileStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
export const deviceKey = (pad: PadReading) => JSON.stringify([pad.id, pad.axes.length, pad.buttons.length, pad.mapping]);

/** User-selected default: AETR, with collective on T and independent motor arming. */
export function defaultProfile(pad: PadReading): PadProfile {
  const aetr: Record<Channel, number> = { roll: 0, pitch: 1, collective: 2, yaw: 3 };
  return { version: 1, channels: Object.fromEntries(channels.map(channel => [channel, {
    axis: aetr[channel] < pad.axes.length ? aetr[channel] : null,
    inverted: false, deadzone: channel === 'collective' ? 0 : 0.025,
    min: -1, center: 0, max: 1,
  }])) as Record<Channel, AxisMapping>, arm: { source: 'none', index: 0, inverted: false } };
}

/** Normalize each side separately; an off-center or asymmetric transmitter still reaches ±1. */
export function normalizeAxis(raw: number, mapping: AxisMapping): number {
  if (!Number.isFinite(raw)) return 0;
  const delta = raw - mapping.center;
  const span = delta >= 0 ? mapping.max - mapping.center : mapping.center - mapping.min;
  if (!Number.isFinite(span) || span < 0.02) return 0;
  let value = clamp(delta / span, -1, 1);
  const deadzone = clamp(mapping.deadzone, 0, 0.2);
  value = Math.abs(value) <= deadzone ? 0 : Math.sign(value) * (Math.abs(value) - deadzone) / (1 - deadzone);
  return mapping.inverted ? -value : value;
}
export function armSignal(pad: PadReading, arm: ArmMapping): number | undefined {
  if (arm.source === 'none') return undefined;
  const value = arm.source === 'axis' ? pad.axes[arm.index] : (pad.buttons[arm.index]?.value ?? NaN) * 2 - 1;
  return arm.inverted ? -value : value;
}
export function mapPad(pad: PadReading, profile: PadProfile, previousMotor = false): MappedInput {
  const output: MappedInput = {};
  for (const channel of channels) {
    const mapping = profile.channels[channel];
    if (mapping.axis !== null && Number.isFinite(pad.axes[mapping.axis])) output[channel] = normalizeAxis(pad.axes[mapping.axis], mapping);
  }
  const signal = armSignal(pad, profile.arm);
  // A small Schmitt band stops a noisy switch at center from chattering.
  if (signal !== undefined) output.motor = Number.isFinite(signal) && (previousMotor ? signal > -0.05 : signal > 0.05);
  return output;
}

export function profileErrors(profile: PadProfile, pad: PadReading): string[] {
  const errors: string[] = [], used = new Map<number, Channel>();
  let assigned = 0;
  for (const channel of channels) {
    const m = profile.channels[channel];
    if (m.axis === null) continue;
    assigned++;
    if (!Number.isInteger(m.axis) || m.axis < 0 || m.axis >= pad.axes.length) errors.push(`${channelNames[channel]}：通道不存在`);
    if (used.has(m.axis)) errors.push(`${channelNames[channel]}与${channelNames[used.get(m.axis)!]}使用了同一通道`);
    used.set(m.axis, channel);
    if (![m.min, m.center, m.max, m.deadzone].every(Number.isFinite) || m.min < -1 || m.max > 1 || m.center - m.min < 0.02 || m.max - m.center < 0.02 || m.deadzone < 0 || m.deadzone > 0.2) errors.push(`${channelNames[channel]}：校准范围或死区无效`);
  }
  const arm = profile.arm;
  if (!arm || !['none', 'axis', 'button'].includes(arm.source) || typeof arm.inverted !== 'boolean') errors.push('解锁通道设置无效');
  else if (arm.source !== 'none') {
    const count = arm.source === 'axis' ? pad.axes.length : pad.buttons.length;
    if (!Number.isInteger(arm.index) || arm.index < 0 || arm.index >= count) errors.push('解锁通道不存在');
    if (arm.source === 'axis' && used.has(arm.index)) errors.push('解锁开关不能与操纵杆共用通道');
  }
  if (!assigned) errors.push('请至少分配一个操纵通道，其余通道可由键盘控制');
  return errors;
}

/** Calibration is transactional: draft settings change only after BOTH endpoints are observed. */
export class CalibrationCapture {
  readonly key: string;
  readonly index: number;
  readonly samples: Partial<Record<Channel, { min: number; center: number; max: number }>> = {};
  private profile: PadProfile;
  constructor(pad: PadReading, profile: PadProfile) {
    const errors = profileErrors(profile, pad);
    if (errors.length) throw new Error(errors.join('；'));
    this.key = deviceKey(pad); this.index = pad.index; this.profile = structuredClone(profile);
    for (const channel of channels) {
      const axis = profile.channels[channel].axis;
      if (axis === null) continue;
      const center = pad.axes[axis];
      if (!Number.isFinite(center)) throw new Error('设备输入无效，请重新连接');
      this.samples[channel] = { min: center, center, max: center };
    }
  }
  observe(pad: PadReading) {
    if (!pad.connected || pad.index !== this.index || deviceKey(pad) !== this.key) throw new Error('校准设备已断开，请重新选择设备');
    for (const channel of channels) {
      const sample = this.samples[channel], axis = this.profile.channels[channel].axis;
      if (!sample || axis === null) continue;
      const raw = pad.axes[axis];
      if (!Number.isFinite(raw)) throw new Error('设备输入无效，已取消本次校准');
      sample.min = Math.min(sample.min, clamp(raw, -1, 1));
      sample.max = Math.max(sample.max, clamp(raw, -1, 1));
    }
  }
  get incomplete(): Channel[] {
    return channels.filter(channel => {
      const s = this.samples[channel];
      return s && (s.center - s.min < 0.08 || s.max - s.center < 0.08);
    });
  }
  finish(): PadProfile {
    if (this.incomplete.length) throw new Error(`请继续移动到两端：${this.incomplete.map(c => channelNames[c]).join('、')}`);
    const result = structuredClone(this.profile);
    for (const channel of channels) if (this.samples[channel]) Object.assign(result.channels[channel], this.samples[channel]);
    return result;
  }
}

export class ProfileStore {
  private storage: ProfileStorage | null;
  private preferredKey = 'heli-lab.gamepad.preferred.v1';
  constructor(storage: ProfileStorage | null) { this.storage = storage; }
  private key(pad: PadReading) { return `heli-lab.gamepad.v1:${encodeURIComponent(deviceKey(pad))}`; }
  load(pad: PadReading): PadProfile {
    return this.loadSaved(pad) ?? defaultProfile(pad);
  }
  /** Unlike the editing UI, automatic activation must never invent a profile. */
  loadSaved(pad: PadReading): PadProfile | null {
    const fallback = defaultProfile(pad);
    try {
      const data = JSON.parse(this.storage?.getItem(this.key(pad)) ?? 'null');
      if (data?.version !== 1 || !data.channels) return null;
      const profile = structuredClone(fallback);
      for (const channel of channels) {
        const m = data.channels[channel];
        if (!m || typeof m.inverted !== 'boolean' || (m.axis !== null && !Number.isInteger(m.axis)) || ![m.min, m.center, m.max, m.deadzone].every(Number.isFinite)) return null;
        profile.channels[channel] = { axis: m.axis, inverted: m.inverted, deadzone: m.deadzone, min: m.min, center: m.center, max: m.max };
      }
      // Old v1 profiles did not have an arming mapping. Keep their calibration.
      if (data.arm !== undefined) profile.arm = { source: data.arm?.source, index: data.arm?.index, inverted: data.arm?.inverted };
      return profileErrors(profile, pad).length ? null : profile;
    } catch { return null; }
  }
  /** null: legacy/no preference; false: explicitly disabled; string: device identity. */
  preferredDevice(): string | null | false {
    try {
      const value = this.storage?.getItem(this.preferredKey);
      if (value === 'disabled') return false;
      const key = JSON.parse(value ?? 'null');
      return Array.isArray(key) && key.length === 4 && typeof key[0] === 'string'
        && Number.isInteger(key[1]) && Number.isInteger(key[2]) && typeof key[3] === 'string' ? value! : null;
    } catch { return null; }
  }
  disableAutoRestore() {
    try { this.storage?.setItem(this.preferredKey, 'disabled'); } catch { /* Session disable still works. */ }
  }
  save(pad: PadReading, profile: PadProfile): boolean {
    if (profileErrors(profile, pad).length) return false;
    try {
      if (!this.storage) return false;
      this.storage.setItem(this.key(pad), JSON.stringify(profile));
      this.storage.setItem(this.preferredKey, deviceKey(pad));
      return true;
    } catch { return false; }
  }
}

/** Poll once per render frame, including during configuration.
 * Device index is only a session locator; identity guards against index reuse on hot-plug.
 */
export class GamepadController {
  devices: PadReading[] = [];
  output: MappedInput = {};
  error = '';
  active = false;
  activeName = '';
  activeIndex: number | null = null;
  private activeKey = '';
  private profile: PadProfile | null = null;
  private read: () => readonly (PadReading | null)[];
  private onLost: (message: string) => void;
  private store?: ProfileStore;
  private restorePending = true;
  private restoreSignature = '';
  private restoreCandidate?: { index: number; key: string; profile: PadProfile };
  constructor(read: () => readonly (PadReading | null)[], onLost: (message: string) => void, store?: ProfileStore) {
    this.read = read; this.onLost = onLost;
    this.store = store;
  }
  private restoreSavedDevice() {
    if (!this.store || !this.restorePending) return;
    const signature = JSON.stringify(this.devices.map(p => [p.index, deviceKey(p)]));
    // Read/validate storage on device changes, not on every input frame. Browsers
    // may expose the radio only after its first button/stick interaction.
    if (signature !== this.restoreSignature) {
      this.restoreSignature = signature;
      const preferred = this.store.preferredDevice();
      this.restoreCandidate = undefined;
      if (preferred === false) { this.restorePending = false; return; }
      const candidates = this.devices.filter(p => preferred === null || deviceKey(p) === preferred)
        .map(pad => ({ index: pad.index, key: deviceKey(pad), profile: this.store!.loadSaved(pad) }))
        .filter((p): p is { index: number; key: string; profile: PadProfile } => p.profile !== null);
      // Existing profiles predate preferred-device storage. Restore the one
      // unambiguous saved device, but don't guess between identical radios.
      if (candidates.length === 1) this.restoreCandidate = candidates[0];
    }
    const candidate = this.restoreCandidate;
    if (!candidate) return;
    const pad = this.devices.find(p => p.index === candidate.index && deviceKey(p) === candidate.key);
    if (!pad) return;
    try { this.enable(pad, candidate.profile); }
    catch { /* Wait for a valid first reading without overwriting saved calibration. */ }
  }
  poll() {
    try {
      this.devices = this.read().filter((p): p is PadReading => Boolean(p?.connected));
      this.error = '';
    } catch {
      this.devices = [];
      this.error = '浏览器无法读取手柄，请在支持 Gamepad API 的浏览器中打开本地页面';
    }
    if (!this.active) this.restoreSavedDevice();
    const previousMotor = this.output.motor ?? false;
    this.output = {};
    if (!this.active || !this.profile) return;
    const pad = this.devices.find(p => p.index === this.activeIndex && deviceKey(p) === this.activeKey);
    const invalid = pad && (channels.some(c => {
      const axis = this.profile!.channels[c].axis;
      return axis !== null && !Number.isFinite(pad.axes[axis]);
    }) || (this.profile.arm.source !== 'none' && !Number.isFinite(armSignal(pad, this.profile.arm))));
    if (!pad || invalid) {
      this.deactivate();
      this.onLost(invalid ? '遥控器输入异常，电机已关闭。请检查通道设置。' : '遥控器已断开，电机已关闭。重新连接后请再次启用。');
      return;
    }
    this.output = mapPad(pad, this.profile, previousMotor);
  }
  enable(pad: PadReading, profile: PadProfile) {
    const current = this.devices.find(p => p.index === pad.index && deviceKey(p) === deviceKey(pad));
    if (!current) throw new Error('设备已断开，请重新连接');
    const errors = profileErrors(profile, current);
    if (errors.length) throw new Error(errors.join('；'));
    if (channels.some(c => profile.channels[c].axis !== null && !Number.isFinite(current.axes[profile.channels[c].axis!]))) throw new Error('设备输入无效，请重新连接');
    if (profile.arm.source !== 'none' && !Number.isFinite(armSignal(current, profile.arm))) throw new Error('解锁通道输入无效');
    this.profile = structuredClone(profile);
    this.restorePending = false; this.restoreCandidate = undefined;
    this.activeIndex = current.index; this.activeKey = deviceKey(current); this.activeName = current.id;
    this.active = true; this.output = mapPad(current, this.profile);
  }
  profileFor(pad: PadReading): PadProfile | null {
    return this.active && this.profile && pad.index === this.activeIndex && deviceKey(pad) === this.activeKey ? structuredClone(this.profile) : null;
  }
  private deactivate() {
    this.restorePending = false; this.restoreCandidate = undefined;
    this.active = false; this.activeIndex = null; this.activeName = ''; this.output = {}; this.profile = null;
  }
  disable() { this.deactivate(); this.store?.disableAutoRestore(); }
}
