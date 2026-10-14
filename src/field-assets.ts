import { defaultField, fieldDownloadBytes, fieldTextureURLs, type FieldMap, type FieldQuality } from './field.ts';

export const fieldCacheName = 'rotorever-fields-v1';
type Asset = FieldMap['tiers']['preview']['files'][number];
export interface AssetCache {
  match(key: string): Promise<Response | undefined>;
  put(key: string, response: Response): Promise<void>;
  delete(key: string): Promise<boolean>;
}
export type FieldProgress = (loaded: number, total: number) => void;
export interface TextureURLs { urls: string[]; release(): void }
export type FieldTextureSource = (tier: FieldQuality) => Promise<TextureURLs>;

/** Network access is restricted to the default field and explicit download().
 * Cache keys include each file's SHA-256, so a new release cannot reuse old faces.
 * A partial download remains resumable but is never advertised as ready.
 */
export class FieldAssets {
  private openCache: () => Promise<AssetCache>;
  private fetchAsset: typeof fetch;
  private downloads = new Map<string, Promise<void>>();
  constructor(privateBase: string, options: { openCache?: () => Promise<AssetCache>; fetch?: typeof fetch } = {}) {
    this.base = privateBase;
    this.openCache = options.openCache ?? (() => caches.open(fieldCacheName));
    this.fetchAsset = options.fetch ?? ((...args) => fetch(...args));
  }
  private base: string;
  private key(map: FieldMap, asset: Asset) {
    return `${this.base.endsWith('/') ? this.base : `${this.base}/`}environments/${map.field.id}/${asset.file}?v=${asset.sha256}`;
  }
  private async cached(cache: AssetCache, map: FieldMap, asset: Asset) {
    const key = this.key(map, asset), response = await cache.match(key);
    if (!response) return undefined;
    const blob = await response.blob();
    if (blob.size === asset.bytes) return blob;
    await cache.delete(key);
    return undefined;
  }
  async isCached(map: FieldMap): Promise<boolean> {
    try {
      const cache = await this.openCache();
      const found = await Promise.all([...map.tiers.preview.files, ...map.tiers.standard.files].map(asset => this.cached(cache, map, asset)));
      return found.every(Boolean);
    } catch { return false; }
  }
  private async asset(map: FieldMap, asset: Asset, network: boolean, cacheRequired: boolean): Promise<Blob> {
    let cache: AssetCache | undefined;
    try {
      cache = await this.openCache();
      const saved = await this.cached(cache, map, asset);
      if (saved) return saved;
    } catch {
      cache = undefined;
      if (cacheRequired) throw new Error('浏览器无法使用本地缓存，请检查网站存储权限后重试。');
    }
    if (!network) throw new Error('本地地图不完整或已被清理，请重新点击下载。');
    let response: Response;
    try { response = await this.fetchAsset(this.key(map, asset)); }
    catch { throw new Error('地图下载失败，请检查网络后重试。'); }
    if (!response.ok) throw new Error('地图下载失败，请检查网络后重试。');
    const bytes = await response.arrayBuffer();
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join('');
    if (bytes.byteLength !== asset.bytes || hash !== asset.sha256) throw new Error('地图文件校验失败，请重新下载。');
    const blob = new Blob([bytes], { type: 'image/webp' });
    if (cache) {
      try { await cache.put(this.key(map, asset), new Response(blob)); }
      catch { if (cacheRequired) throw new Error('本地缓存空间不足或不可用，请释放浏览器存储空间后重试。'); }
    }
    return blob;
  }
  /** The only entry point that permits downloads for optional maps. */
  download(map: FieldMap, onProgress: FieldProgress = () => {}): Promise<void> {
    const existing = this.downloads.get(map.field.id);
    if (existing) return existing;
    const run = async () => {
      const files = [...map.tiers.preview.files, ...map.tiers.standard.files];
      let next = 0, loaded = 0;
      onProgress(0, fieldDownloadBytes(map));
      // Limit concurrent decodes and cache writes on small mobile devices.
      const results = await Promise.allSettled(Array.from({ length: 3 }, async () => {
        while (next < files.length) {
          const file = files[next++];
          await this.asset(map, file, true, true);
          loaded += file.bytes; onProgress(loaded, fieldDownloadBytes(map));
        }
      }));
      const failed = results.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      if (!await this.isCached(map)) throw new Error('地图未能完整保存到本地，请重试。');
    };
    const promise = run().finally(() => this.downloads.delete(map.field.id));
    this.downloads.set(map.field.id, promise);
    return promise;
  }
  /** Optional maps are always cache-only, including after browser eviction. */
  source(map: FieldMap): FieldTextureSource {
    return async tier => {
      const blobs = await Promise.all(map.tiers[tier].files.map(asset => this.asset(map, asset, map === defaultField, false)));
      const urls = blobs.map(blob => URL.createObjectURL(blob));
      return { urls, release: () => urls.forEach(url => URL.revokeObjectURL(url)) };
    };
  }
}

/** Direct source for standalone rendering harnesses; production uses FieldAssets. */
export function directFieldSource(map: FieldMap, base: string): FieldTextureSource {
  return async tier => ({ urls: fieldTextureURLs(tier, base, map), release() {} });
}
