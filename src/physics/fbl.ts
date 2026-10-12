/** Independent torque-domain controller gains; NOT Rotorflight configurator units. */
export const fblAxes = ['roll', 'pitch', 'yaw'] as const;
export type FblAxis = typeof fblAxes[number];
export const gainKeys = ['p', 'i', 'd', 'ff', 'b'] as const;
export type GainKey = typeof gainKeys[number];
export interface AxisGains { p: number; i: number; d: number; ff: number; b: number }
export interface FblProfile {
  roll: AxisGains; pitch: AxisGains; yaw: AxisGains;
  dCutoff: number; bCutoff: number; relaxCutoff: number;
}
export const defaultFbl = (): FblProfile => ({
  roll: { p: 85, i: 30, d: 0.35, ff: 100, b: 40 },
  pitch: { p: 85, i: 30, d: 0.35, ff: 100, b: 40 },
  yaw: { p: 85, i: 30, d: 0.35, ff: 100, b: 40 },
  dCutoff: 60, bCutoff: 25, relaxCutoff: 12,
});
export const gainBounds = {
  p: { min: 0, max: 150, step: 1 }, i: { min: 0, max: 150, step: 1 },
  d: { min: 0, max: 1.5, step: 0.01 }, ff: { min: 0, max: 200, step: 5 },
  b: { min: 0, max: 150, step: 5 },
} as const;
export const filterKeys = ['dCutoff', 'bCutoff', 'relaxCutoff'] as const;
export const filterBounds = { min: 5, max: 80, step: 1 };
export function validFbl(value: unknown): value is FblProfile {
  if (!value || typeof value !== 'object') return false;
  const data = value as FblProfile;
  return fblAxes.every(axis => data[axis] && gainKeys.every(key => {
    const v = data[axis][key], bounds = gainBounds[key];
    return Number.isFinite(v) && v >= bounds.min && v <= bounds.max;
  })) && filterKeys.every(key => Number.isFinite(data[key]) && data[key] >= filterBounds.min && data[key] <= filterBounds.max);
}
export function readFbl(json: string | null): FblProfile {
  try {
    const value: unknown = JSON.parse(json ?? 'null');
    if (validFbl(value)) return copyFbl(value);
  } catch { /* Corrupt settings fall back to the tuned default. */ }
  return defaultFbl();
}
export function copyFbl(profile: FblProfile): FblProfile {
  return { roll: { ...profile.roll }, pitch: { ...profile.pitch }, yaw: { ...profile.yaw },
    dCutoff: profile.dCutoff, bCutoff: profile.bCutoff, relaxCutoff: profile.relaxCutoff };
}
export interface PidTerms { p: number; i: number; d: number; ff: number; b: number; saturated: boolean }
export const zeroPidTerms = (): PidTerms => ({ p: 0, i: 0, d: 0, ff: 0, b: 0, saturated: false });
