import pkg from '../package.json' with { type: 'json' };

export const release = {
  version: pkg.version,
  features: [
    '新增电机、主齿、皮带、主桨、尾桨五通道声音，随实际转速与负载变化。',
    '抽螺距触发主桨爆桨；尾桨猛烈急停、变向才爆响，动作越猛声音越大。',
    '主桨声随桨盘朝向变化；尾桨自旋时产生远近循环，保留调好的混音与余音。',
    'MENU 新增声音设置，各通道音量和爆桨参数可调并自动保存。',
    '速率设置新增实时操纵曲线，飞场列表新增场景缩略图。',
  ],
};

export const welcomeStorageKey = 'rotorever.welcome.completed';
export const releaseStorageKey = 'rotorever.release.seen';
type WelcomeStorage = { getItem(key: string): string | null; setItem(key: string, value: string): void };

export class WelcomeState {
  private completed = false;
  private seenVersion: string | null = null;
  private version: string;
  private storage: WelcomeStorage | null;
  constructor(storage: WelcomeStorage | null, version = release.version) {
    this.storage = storage;
    this.version = version;
    try { this.completed = storage?.getItem(welcomeStorageKey) === '1'; } catch { /* Private browsing can block storage. */ }
    try { this.seenVersion = storage?.getItem(releaseStorageKey) ?? null; } catch { /* Show updates when storage is unavailable. */ }
  }
  get firstRun() { return !this.completed; }
  get hasUpdate() { return this.completed && this.seenVersion !== this.version; }
  get showOnLaunch() { return this.firstRun || this.hasUpdate; }
  complete() {
    this.completed = true;
    this.seenVersion = this.version;
    try { this.storage?.setItem(welcomeStorageKey, '1'); } catch { /* Still dismiss for this session. */ }
    try { this.storage?.setItem(releaseStorageKey, this.version); } catch { /* Still remember the version for this session. */ }
  }
}
