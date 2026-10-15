import manifest from '../public/environments/river-meadow-hd/manifest.json' with { type: 'json' };
import city from '../public/environments/x5-grassland/manifest.json' with { type: 'json' };
import river from '../public/environments/river-meadow/manifest.json' with { type: 'json' };

export type FieldQuality = 'preview' | 'standard';
export type FieldDefinition = typeof manifest.field;
export interface FieldMap {
  field: FieldDefinition;
  description: string;
  tag: string;
  thumbnail: { file: string; width: number; height: number; bytes: number; sha256: string };
  tiers: Record<FieldQuality, { size: number; bytes: number; files: { file: string; bytes: number; sha256: string }[] }>;
}

/** Metadata only. The picker loads thumbnails on open; cube textures stay opt-in. */
export const fields: readonly FieldMap[] = [
  { field: manifest.field, tiers: manifest.tiers, thumbnail: manifest.thumbnail, tag: '高清', description: '开阔草地 · 远处河流 · 高清细节' },
  { field: city.field, tiers: city.tiers, thumbnail: city.thumbnail, tag: '实拍', description: '城市天际线 · 全景相机实地拍摄' },
  { field: river.field, tiers: river.tiers, thumbnail: river.thumbnail, tag: '轻量', description: '平坦草坪 · 河畔远景 · 小体积' },
];
export const defaultField = fields[0];
export const fieldDownloadBytes = (map: FieldMap) => map.tiers.preview.bytes + map.tiers.standard.bytes;

/** The offline importer owns the shared frame for photo, contact and sunlight.
 * Add future fields using the same manifest contract, without renderer changes.
 * Distances are metres; lightRay points FROM the sun toward the ground.
 */
export const field = Object.freeze({
  ...manifest.field,
  pilot: Object.freeze(manifest.field.pilot),
  lightRay: Object.freeze(manifest.field.lightRay),
  lighting: Object.freeze(manifest.field.lighting),
});

/** Accept Vite's base explicitly so subdirectory deployments remain portable. */
export function fieldTextureURLs(tier: FieldQuality, baseURL: string, map: FieldMap = defaultField) {
  const base = baseURL.endsWith('/') ? baseURL : `${baseURL}/`;
  return map.tiers[tier].files.map(asset => `${base}environments/${map.field.id}/${asset.file}`);
}

export function fieldThumbnailURL(map: FieldMap, baseURL: string) {
  const base = baseURL.endsWith('/') ? baseURL : `${baseURL}/`;
  return `${base}environments/${map.field.id}/${map.thumbnail.file}?v=${map.thumbnail.sha256}`;
}

/** Parallel sunlight intersection with the same plane used by physics. */
export function groundProjection(point: { x: number; y: number; z: number }, field: FieldDefinition = defaultField.field) {
  const t = (field.groundY - point.y) / field.lightRay.y;
  return { x: point.x + t * field.lightRay.x, y: field.groundY, z: point.z + t * field.lightRay.z };
}
