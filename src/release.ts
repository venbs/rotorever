import pkg from '../package.json' with { type: 'json' };

export const release = {
  version: pkg.version,
  features: [
    '三张飞场自由切换，新增高清河畔草地。',
    '地图按需下载，本地缓存，重复切换免下载。',
    '新增首次体验引导，快速找到常用设置。',
  ],
};

export const welcomeStorageKey = 'rotorever.welcome.completed';
type WelcomeStorage = { getItem(key: string): string | null; setItem(key: string, value: string): void };

export class WelcomeState {
  private completed = false;
  private storage: WelcomeStorage | null;
  constructor(storage: WelcomeStorage | null) {
    this.storage = storage;
    try { this.completed = storage?.getItem(welcomeStorageKey) === '1'; } catch { /* Private browsing can block storage. */ }
  }
  get firstRun() { return !this.completed; }
  complete() {
    this.completed = true;
    try { this.storage?.setItem(welcomeStorageKey, '1'); } catch { /* Still dismiss for this session. */ }
  }
}
