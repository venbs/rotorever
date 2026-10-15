import { audioChannels, defaultAudioProfile, saveAudioProfile, type AudioChannel, type AudioProfile } from './settings.ts';
import type { ProfileStorage } from '../gamepad.ts';
import { HelicopterAudio } from './engine.ts';

const names: Record<AudioChannel, string> = { motor: '电机', gear: '主齿', belt: '皮带', main: '主桨', tail: '尾桨' };
type NumberKey = 'volume' | 'mainImpact' | 'mainCrisp' | 'impact' | 'tailBurstPitch' | 'tailDecay' | 'mainDirectivity';
export class SoundPanel {
  readonly dialog = document.createElement('dialog');
  private profile: AudioProfile;
  private saved = true;
  private audio: HelicopterAudio;
  private storage: ProfileStorage | null;
  private onOpen: () => void;
  constructor(profile: AudioProfile, audio: HelicopterAudio, storage: ProfileStorage | null, onOpen: () => void) {
    this.audio = audio; this.storage = storage; this.onOpen = onOpen;
    this.profile = structuredClone(profile);
    const range = (key: NumberKey, label: string, min: number, max: number, step = 1, unit = '%') =>
      `<label class="sound-range" for="sound-${key}"><span>${label}<output data-sound-value="${key}" data-unit="${unit}"></output></span><input id="sound-${key}" data-sound-number="${key}" type="range" min="${min}" max="${max}" step="${step}"></label>`;
    const d = this.dialog; d.id = 'sound-dialog'; d.setAttribute('aria-labelledby', 'sound-title');
    d.innerHTML = `
      <header class="dialog-head"><div><span class="eyebrow">SOUND / FLIGHT</span><h2 id="sound-title">声音设置</h2></div><button class="icon-button" aria-label="关闭声音设置">×</button></header>
      <div class="sound-body">
        <div class="sound-power"><label><input id="sound-enabled" type="checkbox">开启飞行声音</label><button id="sound-unlock" class="text-button" type="button">启用 / 重试声音</button></div>
        ${range('volume', '总音量', 0, 100)}
        <section class="sound-channels" aria-label="各通道音量">${audioChannels.map(name => `
          <div class="sound-channel"><label for="sound-channel-${name}"><input id="sound-channel-${name}" data-sound-channel="${name}" type="checkbox">${names[name]}</label><output data-sound-gain-value="${name}"></output><input type="range" aria-label="${names[name]}音量" data-sound-gain="${name}" min="0" max="200" step="1"></div>`).join('')}
        </section>
        ${range('mainDirectivity', '主桨朝向变化强度', 0, 100)}
        <p class="setting-note">桨盘正对镜头时更响，侧对时更轻。尾桨声音随尾端实际位置远近变化。</p>
        <details class="sound-details"><summary>爆桨与换向</summary>
          <label class="sound-check"><input id="sound-mainTransients" type="checkbox">主桨爆桨</label>
          <div class="sound-grid">${range('mainImpact', '主桨爆桨响度', 0, 100)}${range('mainCrisp', '主桨爆桨亮度', 0, 100)}</div>
          <label class="sound-check"><input id="sound-transients" type="checkbox">尾桨换向爆发</label>
          <label class="sound-select" for="sound-tailVoice">尾桨换向音色<select id="sound-tailVoice"><option value="hybrid">融合音色</option><option value="recording">实录起音</option></select></label>
          <div class="sound-grid">${range('impact', '尾桨爆发响度', 0, 200)}${range('tailBurstPitch', '尾桨爆发音高', -4, 12, .5, '半音')}</div>
          ${range('tailDecay', '尾桨换向余音', .1, 2, .05, '秒')}
        </details>
      </div>
      <footer class="dialog-footer"><span id="sound-message" role="status"></span><button class="text-button" id="sound-defaults" type="button">恢复已标定参数</button></footer>`;
    document.body.append(d);
    d.querySelector<HTMLButtonElement>('.icon-button')!.onclick = () => d.close();
    d.querySelector<HTMLButtonElement>('#sound-unlock')!.onclick = async () => {
      this.profile.soundEnabled = true; this.fill(); this.apply(); this.persist(); await this.audio.unlock(); this.updateStatus();
    };
    d.querySelector<HTMLButtonElement>('#sound-defaults')!.onclick = () => {
      this.profile = defaultAudioProfile(); this.fill(); this.apply(); this.persist(); void this.audio.unlock().then(() => this.updateStatus());
    };
    for (const field of d.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select')) {
      field.addEventListener('input', () => {
        const p = this.profile;
        for (const node of d.querySelectorAll<HTMLInputElement>('[data-sound-number]')) p[node.dataset.soundNumber as NumberKey] = node.valueAsNumber;
        for (const node of d.querySelectorAll<HTMLInputElement>('[data-sound-gain]')) p.channelVolumes[node.dataset.soundGain as AudioChannel] = node.valueAsNumber;
        for (const node of d.querySelectorAll<HTMLInputElement>('[data-sound-channel]')) p.enabled[node.dataset.soundChannel as AudioChannel] = node.checked;
        p.soundEnabled = this.input('enabled').checked; p.mainTransients = this.input('mainTransients').checked; p.transients = this.input('transients').checked;
        p.tailVoice = d.querySelector<HTMLSelectElement>('#sound-tailVoice')!.value as AudioProfile['tailVoice'];
        this.apply(); this.values();
        if (field.id === 'sound-enabled' && p.soundEnabled) void this.audio.unlock().then(() => this.updateStatus());
      });
      field.addEventListener('change', () => this.persist());
    }
    this.fill();
  }
  open() { this.onOpen(); this.fill(); this.updateStatus(); this.dialog.showModal(); }
  updateStatus() {
    if (!this.dialog.open) return;
    const d = this.audio.diagnostics;
    const status = !this.profile.soundEnabled ? '声音已关闭' : d.error ? d.error : d.context === 'locked' || d.context === 'suspended' ? '点击启用声音' :
      d.samplesReady ? '声音已启用' : '持续声已就绪 · 正在加载爆桨音效';
    const node = this.dialog.querySelector<HTMLElement>('#sound-message')!;
    const text = `${status} · ${this.saved ? '设置保存在本机' : '本次会话有效'}`;
    if (node.textContent !== text) node.textContent = text;
  }
  private input(key: string) { return this.dialog.querySelector<HTMLInputElement>(`#sound-${key}`)!; }
  private apply() { this.audio.setProfile(this.profile); this.updateStatus(); }
  private persist() { this.saved = saveAudioProfile(this.storage, this.profile); this.updateStatus(); }
  private fill() {
    const p = this.profile;
    for (const node of this.dialog.querySelectorAll<HTMLInputElement>('[data-sound-number]')) node.value = String(p[node.dataset.soundNumber as NumberKey]);
    for (const node of this.dialog.querySelectorAll<HTMLInputElement>('[data-sound-gain]')) node.value = String(p.channelVolumes[node.dataset.soundGain as AudioChannel]);
    for (const node of this.dialog.querySelectorAll<HTMLInputElement>('[data-sound-channel]')) node.checked = p.enabled[node.dataset.soundChannel as AudioChannel];
    this.input('enabled').checked = p.soundEnabled; this.input('mainTransients').checked = p.mainTransients; this.input('transients').checked = p.transients;
    this.dialog.querySelector<HTMLSelectElement>('#sound-tailVoice')!.value = p.tailVoice; this.values();
  }
  private values() {
    for (const node of this.dialog.querySelectorAll<HTMLOutputElement>('[data-sound-value]')) {
      const key = node.dataset.soundValue as NumberKey, value = this.profile[key], unit = node.dataset.unit;
      node.textContent = `${key === 'tailDecay' ? value.toFixed(2) : key === 'tailBurstPitch' ? value.toFixed(1) : value}${unit === '%' ? '' : ' '}${unit}`;
    }
    for (const node of this.dialog.querySelectorAll<HTMLOutputElement>('[data-sound-gain-value]')) node.textContent = `${this.profile.channelVolumes[node.dataset.soundGainValue as AudioChannel]}%`;
  }
}
