import { defaultField, fields, fieldDownloadBytes, fieldThumbnailURL, type FieldMap } from './field.ts';
import { FieldAssets } from './field-assets.ts';

const megabytes = (bytes: number) => `${(bytes / 1_000_000).toFixed(2)} MB`;
type MapState = { cached: boolean; downloading: boolean; progress: number; message: string; error: boolean };

export class FieldPanel {
  readonly dialog: HTMLDialogElement;
  private active = defaultField.field.id;
  private initialLoading = true;
  private initialFailed = false;
  private switching = '';
  private states = new Map<string, MapState>(fields.map(map => [map.field.id, { cached: false, downloading: false, progress: 0, message: '', error: false }]));
  private assets: FieldAssets;
  private onSelect: (map: FieldMap) => Promise<void>;
  private onOpen: () => void;

  constructor(assets: FieldAssets, onSelect: (map: FieldMap) => Promise<void>, onOpen: () => void) {
    this.assets = assets; this.onSelect = onSelect; this.onOpen = onOpen;
    const dialog = this.dialog = document.createElement('dialog');
    dialog.id = 'field-dialog'; dialog.setAttribute('aria-labelledby', 'field-title');
    dialog.innerHTML = `
      <header class="dialog-head"><div><span class="eyebrow">SCENERY / COLLECTION</span><h2 id="field-title">选择你的飞场</h2></div><button aria-label="关闭飞场设置">×</button></header>
      <div class="field-body"><p class="field-intro">每次启动进入默认飞场。其他地图，下载一次即可在本机切换。</p>
      <div class="field-list">${fields.map((map, index) => `
        <article class="field-card" data-map="${map.field.id}" aria-labelledby="field-name-${index}">
          <div class="field-thumbnail">
            <span class="field-thumbnail-fallback" aria-hidden="true">飞场预览</span>
            <img data-src="${fieldThumbnailURL(map, import.meta.env.BASE_URL)}" width="${map.thumbnail.width}" height="${map.thumbnail.height}" alt="${map.field.name}场景预览" loading="lazy" decoding="async">
            <span class="field-number" aria-hidden="true">0${index + 1}</span><span class="field-tag">${map.tag}</span>
          </div>
          <div class="field-card-content">
            <div class="field-card-heading"><h3 id="field-name-${index}">${map.field.name}</h3><p>${map.description}</p></div>
            <div class="field-card-bottom"><span class="field-size">${megabytes(fieldDownloadBytes(map))}${index === 0 ? ' · 默认飞场' : ''}</span><p class="field-state" role="status"></p><button class="field-action" aria-describedby="field-name-${index}"></button></div>
          </div>
          <progress max="100" value="0" aria-label="${map.field.name}下载进度" hidden></progress>
        </article>`).join('')}</div>
        <p class="field-storage-note">地图保存在当前浏览器。清理网站数据后，需重新下载。</p>
      </div>
      <footer class="dialog-footer"><span>切换飞场会回到起飞点</span><button class="primary field-done">返回飞行</button></footer>`;
    document.body.append(dialog);
    dialog.querySelector<HTMLButtonElement>('.dialog-head button')!.onclick = () => dialog.close();
    dialog.querySelector<HTMLButtonElement>('.field-done')!.onclick = () => dialog.close();
    fields.forEach(map => {
      this.card(map).querySelector<HTMLButtonElement>('.field-action')!.onclick = () => { void this.act(map); };
      const image = this.card(map).querySelector<HTMLImageElement>('img')!;
      image.onerror = () => {
        image.hidden = true;
        this.card(map).querySelector('.field-thumbnail-fallback')!.textContent = '预览暂不可用';
      };
      this.render(map);
    });
  }

  open() {
    this.onOpen(); this.dialog.showModal();
    // Assigning src only here prevents thumbnail requests during initial startup.
    this.dialog.querySelectorAll<HTMLImageElement>('img[data-src]').forEach(image => {
      image.src = image.dataset.src!;
      delete image.dataset.src;
    });
    void this.refresh();
  }
  async loadedDefault(ok: boolean) {
    this.initialLoading = false; this.initialFailed = !ok;
    await this.refresh();
  }
  private async refresh() {
    await Promise.all(fields.map(async map => {
      this.states.get(map.field.id)!.cached = await this.assets.isCached(map);
      this.render(map);
    }));
  }
  private card(map: FieldMap) { return this.dialog.querySelector<HTMLElement>(`[data-map="${map.field.id}"]`)!; }
  private render(map: FieldMap) {
    const state = this.states.get(map.field.id)!, card = this.card(map);
    const current = this.active === map.field.id && !this.initialFailed;
    const button = card.querySelector<HTMLButtonElement>('.field-action')!;
    const status = card.querySelector<HTMLElement>('.field-state')!;
    const loading = map === defaultField && this.initialLoading;
    card.classList.toggle('is-active', current);
    status.classList.toggle('error', state.error);
    status.textContent = state.message || (loading ? '正在加载默认飞场…' : state.cached ? '已下载 · 本地可用' : map === defaultField ? '默认飞场 · 自动加载' : '未下载 · 点击后才使用流量');
    button.textContent = state.downloading ? `下载中 ${state.progress}%` : this.switching === map.field.id ? '切换中…' : loading ? '加载中…' : current ? '正在使用' : state.cached || map === defaultField ? '进入飞场' : state.error ? '重试下载' : '下载地图';
    button.disabled = state.downloading || !!this.switching || loading || current || (this.initialLoading && state.cached);
    button.classList.toggle('primary', !current && !state.downloading);
    const progress = card.querySelector<HTMLProgressElement>('progress')!;
    progress.hidden = !state.downloading; progress.value = state.progress;
  }
  private async act(map: FieldMap) {
    const state = this.states.get(map.field.id)!;
    state.error = false; state.message = '';
    if (map !== defaultField && !state.cached) {
      state.downloading = true; this.render(map);
      try {
        await this.assets.download(map, (loaded, total) => {
          state.progress = Math.floor(loaded / total * 100);
          state.message = `${megabytes(loaded)} / ${megabytes(total)}`;
          this.render(map);
        });
        state.cached = true; state.message = '已下载 · 现在可以进入飞场';
      } catch (error) { state.error = true; state.message = (error as Error).message; }
      finally { state.downloading = false; this.render(map); }
      return;
    }
    this.switching = map.field.id; fields.forEach(item => this.render(item));
    try {
      if (map !== defaultField && !await this.assets.isCached(map)) throw new Error('本地地图已被清理，请重新下载。');
      await this.onSelect(map);
      for (const other of this.states.values()) {
        if (!other.downloading && !other.error) other.message = '';
      }
      this.active = map.field.id; this.initialFailed = false;
      state.message = '正在使用 · 已回到起飞点';
    } catch (error) { state.error = true; state.message = (error as Error).message; }
    finally { this.switching = ''; await this.refresh(); }
  }
}
