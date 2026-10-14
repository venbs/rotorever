import { clamp, type Vec3 } from './math.ts';

/** Independent torque-domain controller gains; NOT Rotorflight configurator units. */
export const fblAxes = ['roll', 'pitch', 'yaw'] as const;
export type FblAxis = typeof fblAxes[number];
export const gainKeys = ['p', 'i', 'd', 'ff', 'b'] as const;
export type GainKey = typeof gainKeys[number];
export interface AxisGains { p: number; i: number; d: number; ff: number; b: number }
export interface FblProfile {
  roll: AxisGains; pitch: AxisGains; yaw: AxisGains;
  dCutoff: number; bCutoff: number; relaxCutoff: number;
  errorRotation: boolean; errorRotationGain: number;
}
// RF 2.2 enables error rotation by default; RF 2.3 always rotates by measured yaw.
// The percentage is a simulator extension: 100% is the RF geometric rotation.
export const defaultErrorRotation = () => ({ errorRotation: true, errorRotationGain: 100 });
export const errorRotationBounds = { min: 0, max: 150, step: 1 };
export const rateIntegralLimit = 0.4; // radians; retain the existing controller's error cap.
// Physics reference controller. The app's pilot-tuned preset lives in defaultAircraft.
export const defaultFbl = (): FblProfile => ({
  roll: { p: 85, i: 30, d: 0.35, ff: 100, b: 40 },
  pitch: { p: 85, i: 30, d: 0.35, ff: 100, b: 40 },
  yaw: { p: 85, i: 30, d: 0.35, ff: 100, b: 40 },
  dCutoff: 60, bCutoff: 25, relaxCutoff: 12,
  ...defaultErrorRotation(),
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
  })) && filterKeys.every(key => Number.isFinite(data[key]) && data[key] >= filterBounds.min && data[key] <= filterBounds.max) &&
    typeof data.errorRotation === 'boolean' && Number.isFinite(data.errorRotationGain) &&
    data.errorRotationGain >= errorRotationBounds.min && data.errorRotationGain <= errorRotationBounds.max;
}
/** Add only absent fields; malformed saved values still fail profile validation. */
export function migrateFbl(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return { ...defaultErrorRotation(), ...value };
}
export function readFbl(json: string | null, fallback: FblProfile = defaultFbl()): FblProfile {
  try {
    const value = migrateFbl(JSON.parse(json ?? 'null'));
    if (validFbl(value)) return copyFbl(value);
  } catch { /* Corrupt settings fall back to the tuned default. */ }
  return copyFbl(fallback);
}
export function copyFbl(profile: FblProfile): FblProfile {
  return { roll: { ...profile.roll }, pitch: { ...profile.pitch }, yaw: { ...profile.yaw },
    dCutoff: profile.dCutoff, bCutoff: profile.bCutoff, relaxCutoff: profile.relaxCutoff,
    errorRotation: profile.errorRotation, errorRotationGain: profile.errorRotationGain };
}
/** Transport stored angle error into the new body frame; X roll, Y yaw, Z pitch. */
export function rotateCyclicError(error: Vec3, yawDelta: number, profile: Pick<FblProfile, 'errorRotation' | 'errorRotationGain'>): Vec3 {
  if (!profile.errorRotation || profile.errorRotationGain === 0 || yawDelta === 0) return error;
  const angle = yawDelta * profile.errorRotationGain / 100;
  const c = Math.cos(angle), s = Math.sin(angle);
  // Inverse body rotation about Y. Rotate the angle error before inertia/I gain,
  // leaving yaw memory intact. Clipping keeps transport within the existing cap.
  return { x: clamp(c * error.x - s * error.z, -rateIntegralLimit, rateIntegralLimit), y: error.y,
    z: clamp(s * error.x + c * error.z, -rateIntegralLimit, rateIntegralLimit) };
}
export interface PidTerms { p: number; i: number; d: number; ff: number; b: number; saturated: boolean }
export const zeroPidTerms = (): PidTerms => ({ p: 0, i: 0, d: 0, ff: 0, b: 0, saturated: false });
