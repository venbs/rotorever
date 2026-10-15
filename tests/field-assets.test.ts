import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { FieldAssets, type AssetCache } from '../src/field-assets.ts';
import { defaultField, fields, fieldTextureURLs, type FieldMap } from '../src/field.ts';
import { WelcomeState, welcomeStorageKey, releaseStorageKey, release } from '../src/release.ts';

class MemoryCache implements AssetCache {
  entries = new Map<string, Response>();
  failWrites = false;
  async match(key: string) { return this.entries.get(key)?.clone(); }
  async put(key: string, response: Response) {
    if (this.failWrites) throw new Error('QuotaExceededError');
    this.entries.set(key, response.clone());
  }
  async delete(key: string) { return this.entries.delete(key); }
}
function fixture() {
  const map: FieldMap = structuredClone(fields[1]);
  const payloads = new Map<string, string>();
  for (const tier of ['preview', 'standard'] as const) {
    for (const asset of map.tiers[tier].files) {
      const body = `test image ${asset.file}`;
      asset.bytes = Buffer.byteLength(body);
      asset.sha256 = createHash('sha256').update(body).digest('hex');
      payloads.set(`/rotorever/environments/${map.field.id}/${asset.file}?v=${asset.sha256}`, body);
    }
    map.tiers[tier].bytes = map.tiers[tier].files.reduce((n, file) => n + file.bytes, 0);
  }
  const cache = new MemoryCache(), requests: string[] = [];
  let offline = false, corrupt = false;
  const fetcher: typeof fetch = async input => {
    const url = String(input); requests.push(url);
    if (offline) throw new Error('offline');
    const body = payloads.get(url);
    return body === undefined ? new Response('missing', { status: 404 }) : new Response(corrupt ? 'bad data' : body);
  };
  return { map, cache, requests, fetcher, assets: new FieldAssets('/rotorever/', { openCache: async () => cache, fetch: fetcher }),
    offline: () => { offline = true; }, corrupt: () => { corrupt = true; } };
}

test('catalog and cache status never download optional maps, including a cold cache-only switch', async () => {
  const f = fixture();
  assert.equal(fields.length, 3);
  assert.equal(fields[0], defaultField);
  assert.equal(new Set(fields.map(map => map.field.id)).size, 3);
  for (const map of fields) {
    assert.equal(await f.assets.isCached(map), false);
    assert.ok(fieldTextureURLs('standard', '/rotorever', map).every(url => url.startsWith(`/rotorever/environments/${map.field.id}/`)));
  }
  await assert.rejects(f.assets.source(f.map)('standard'), /重新点击下载/);
  assert.deepEqual(f.requests, []);
});

test('only default field source can fetch automatically', async () => {
  const requested: string[] = [];
  const assets = new FieldAssets('/rotorever/', { openCache: async () => new MemoryCache(), fetch: async input => {
    requested.push(String(input)); return new Response('offline', { status: 503 });
  } });
  await assert.rejects(assets.source(defaultField)('preview'));
  await assert.rejects(assets.source(fields[1])('preview'));
  await assert.rejects(assets.source(fields[2])('preview'));
  assert.equal(requested.length, 6);
  assert.ok(requested.every(url => url.includes(`/environments/${defaultField.field.id}/preview/`)));
});

test('explicit download saves all faces, reports bytes, deduplicates and survives an offline reopen', async () => {
  const f = fixture(), progress: number[] = [];
  const pending = f.assets.download(f.map, loaded => progress.push(loaded));
  assert.equal(f.assets.download(f.map), pending);
  await pending;
  assert.equal(f.requests.length, 12);
  assert.equal(progress[0], 0);
  assert.equal(progress.at(-1), f.map.tiers.preview.bytes + f.map.tiers.standard.bytes);
  assert.equal(await f.assets.isCached(f.map), true);
  f.offline();
  const reopened = new FieldAssets('/rotorever/', { openCache: async () => f.cache, fetch: f.fetcher });
  for (const tier of ['preview', 'standard'] as const) {
    const lease = await reopened.source(f.map)(tier);
    assert.equal(lease.urls.length, 6);
    assert.ok(lease.urls.every(url => url.startsWith('blob:')));
    lease.release();
  }
  await reopened.download(f.map);
  assert.equal(f.requests.length, 12, 'cached access and redundant download must not fetch');
});

test('partial downloads resume only on explicit download; eviction never triggers a hidden fetch', async () => {
  const f = fixture();
  await f.assets.download(f.map);
  const key = [...f.cache.entries.keys()][0];
  await f.cache.delete(key);
  assert.equal(await f.assets.isCached(f.map), false);
  await assert.rejects(f.assets.source(f.map)('preview'), /重新点击下载/);
  assert.equal(f.requests.length, 12);
  await f.assets.download(f.map);
  assert.equal(f.requests.length, 13);
  assert.equal(await f.assets.isCached(f.map), true);
  await f.cache.put(key, new Response('truncated'));
  assert.equal(await f.assets.isCached(f.map), false);
  assert.equal(f.cache.entries.has(key), false);
});

test('new asset hashes invalidate a cached map without downloading an update', async () => {
  const f = fixture(); await f.assets.download(f.map);
  const updated = structuredClone(f.map);
  updated.tiers.standard.files[0].sha256 = 'new-release-hash';
  assert.equal(await f.assets.isCached(updated), false);
  await assert.rejects(f.assets.source(updated)('standard'));
  assert.equal(f.requests.length, 12);
});

test('network errors, invalid files and storage quota never report a map as ready', async () => {
  for (const failure of ['network', 'checksum', 'quota', 'cache'] as const) {
    const f = fixture();
    if (failure === 'network') f.offline();
    if (failure === 'checksum') f.corrupt();
    if (failure === 'quota') f.cache.failWrites = true;
    const assets = failure === 'cache' ? new FieldAssets('/rotorever/', { fetch: f.fetcher, openCache: async () => { throw new Error('blocked'); } }) : f.assets;
    await assert.rejects(assets.download(f.map));
    assert.equal(await assets.isCached(f.map), false);
    if (failure === 'cache') assert.deepEqual(f.requests, []);
    if (failure === 'quota') {
      f.cache.failWrites = false;
      await assets.download(f.map);
      assert.equal(await assets.isCached(f.map), true, 'a failed download can be retried');
    }
  }
});

test('first-run welcome records the release without overwriting existing settings', () => {
  const data = new Map<string, string>([['aircraft', 'unchanged']]);
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
  const first = new WelcomeState(storage);
  assert.equal(first.firstRun, true);
  assert.equal(first.showOnLaunch, true);
  assert.equal(data.has(welcomeStorageKey), false, 'opening alone does not mark the introduction complete');
  assert.equal(data.has(releaseStorageKey), false);
  first.complete();
  assert.equal(first.firstRun, false);
  assert.equal(new WelcomeState(storage).firstRun, false);
  assert.equal(new WelcomeState(storage).showOnLaunch, false);
  assert.equal(data.get(releaseStorageKey), release.version);
  assert.equal(data.get('aircraft'), 'unchanged');
  assert.equal(release.version, '0.3.0');
});

test('existing users see new release notes once, including migration from the old welcome flag', () => {
  const data = new Map([[welcomeStorageKey, '1'], ['heli-lab.aircraft.v1', 'existing aircraft'], ['heli-lab.audio.v1', 'existing mix']]);
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
  const legacy = new WelcomeState(storage);
  assert.equal(legacy.firstRun, false);
  assert.equal(legacy.hasUpdate, true);
  assert.equal(legacy.showOnLaunch, true);
  assert.equal(data.has(releaseStorageKey), false, 'showing notes alone does not acknowledge the update');
  legacy.complete();
  assert.equal(legacy.showOnLaunch, false);
  assert.equal(new WelcomeState(storage).showOnLaunch, false);
  const nextRelease = new WelcomeState(storage, '0.3.1');
  assert.equal(nextRelease.firstRun, false);
  assert.equal(nextRelease.hasUpdate, true);
  nextRelease.complete();
  assert.equal(new WelcomeState(storage, '0.3.1').showOnLaunch, false);
  assert.equal(data.get('heli-lab.aircraft.v1'), 'existing aircraft');
  assert.equal(data.get('heli-lab.audio.v1'), 'existing mix');
});

test('welcome tolerates unavailable storage and remembers dismissal within the session', () => {
  for (const storage of [null, { getItem() { throw new Error(); }, setItem() { throw new Error(); } }]) {
    const state = new WelcomeState(storage);
    assert.equal(state.firstRun, true);
    state.complete();
    assert.equal(state.firstRun, false);
    assert.equal(state.hasUpdate, false);
    assert.equal(state.showOnLaunch, false);
  }
});
