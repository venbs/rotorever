import { migrateFbl, readFbl, validFbl, copyFbl, type FblProfile } from './physics/fbl.ts';
import type { RateProfile } from './physics/rates.ts';
import { parameters } from './physics/parameters.ts';
import { rad } from './physics/math.ts';
import type { HelicopterSimulation, FlightInput } from './physics/simulator.ts';
import type { ProfileStorage } from './gamepad.ts';

export const aerodynamicKeys = ['liftGain', 'axialDamping', 'bodyDrag'] as const;
export type AerodynamicsProfile = Record<typeof aerodynamicKeys[number], number>;
// Profiles saved before these controls existed used the unscaled force model.
export const neutralAerodynamics = (): AerodynamicsProfile => ({ liftGain: 100, axialDamping: 100, bodyDrag: 100 });
export interface AircraftProfile { mass: number; rpm: number; motorTorque: number; pitch: number; rates: RateProfile; fbl: FblProfile; aerodynamics: AerodynamicsProfile }
export const aircraftStorageKey = 'heli-lab.aircraft.v1';
export const aircraftBounds = {
  mass: { min: 1, max: 8, step: 0.05 }, rpm: { min: 1200, max: 3000, step: 50 },
  motorTorque: { min: 10, max: 100, step: 1 },
  pitch: { min: 5, max: 18, step: 0.5 }, cyclic: { min: 50, max: 800, step: 10 },
  yaw: { min: 50, max: 1200, step: 10 }, expo: { min: 0, max: 80, step: 1 },
  liftGain: { min: 50, max: 200, step: 5 }, axialDamping: { min: 0, max: 200, step: 5 },
  bodyDrag: { min: 0, max: 300, step: 5 },
} as const;
// Pilot's applied Chrome tune, captured 2026-10-15. Keep the physics reference
// mass/inertia intact: applyAircraft scales those to this flight configuration.
export const defaultAircraft = (): AircraftProfile => ({
  mass: 2.8, rpm: 2150, motorTorque: 50, pitch: 12,
  rates: { cyclic: 350, yaw: 650, expo: 0.4 },
  fbl: {
    roll: { p: 50, i: 30, d: 0, ff: 150, b: 40 },
    pitch: { p: 50, i: 30, d: 0, ff: 150, b: 40 },
    yaw: { p: 85, i: 30, d: 0.35, ff: 0, b: 40 },
    dCutoff: 60, bCutoff: 25, relaxCutoff: 12,
    errorRotation: true, errorRotationGain: 100,
  },
  aerodynamics: { liftGain: 70, axialDamping: 120, bodyDrag: 100 },
});
const inRange = (value: unknown, key: keyof typeof aircraftBounds) => typeof value === 'number' && Number.isFinite(value) && value >= aircraftBounds[key].min && value <= aircraftBounds[key].max;
export function validAircraft(value: unknown): value is AircraftProfile {
  if (!value || typeof value !== 'object') return false;
  const p = value as AircraftProfile;
  return inRange(p.mass, 'mass') && inRange(p.rpm, 'rpm') && inRange(p.motorTorque, 'motorTorque') && inRange(p.pitch, 'pitch') && Boolean(p.rates) &&
    inRange(p.rates.cyclic, 'cyclic') && inRange(p.rates.yaw, 'yaw') && inRange(p.rates.expo * 100, 'expo') && validFbl(p.fbl) &&
    Boolean(p.aerodynamics) && aerodynamicKeys.every(key => inRange(p.aerodynamics[key], key));
}
export function loadAircraft(storage: ProfileStorage | null): AircraftProfile {
  const fallback = defaultAircraft();
  try {
    const saved = JSON.parse(storage?.getItem(aircraftStorageKey) ?? 'null');
    // Older unified profiles did not contain the motor control. Keep every other setting.
    if (saved && typeof saved === 'object' && !('motorTorque' in saved)) saved.motorTorque = fallback.motorTorque;
    // A new control must not discard the pilot's existing mass, rates or PID.
    if (saved && typeof saved === 'object') {
      saved.fbl = migrateFbl(saved.fbl);
      if (!('aerodynamics' in saved)) saved.aerodynamics = neutralAerodynamics();
      else if (saved.aerodynamics && typeof saved.aerodynamics === 'object' && !Array.isArray(saved.aerodynamics)) {
        saved.aerodynamics = { ...neutralAerodynamics(), ...saved.aerodynamics };
      }
    }
    if (validAircraft(saved)) return structuredClone(saved);
  } catch { /* Try the existing settings below. */ }
  // Preserve the pilot's previous PID and rate tune when moving into the new UI.
  try { fallback.fbl = readFbl(storage?.getItem('heli-lab.fbl.v1') ?? null, fallback.fbl); } catch { /* Session defaults. */ }
  try {
    const rates = JSON.parse(storage?.getItem('heli-lab.rates.v1') ?? 'null');
    if (rates && validAircraft({ ...fallback, rates })) fallback.rates = { ...rates };
  } catch { /* Session defaults. */ }
  return fallback;
}
export function applyAircraft(sim: HelicopterSimulation, input: FlightInput, profile: AircraftProfile) {
  if (!validAircraft(profile)) throw new Error('机体参数超出范围');
  sim.params.mass = profile.mass;
  // Added mass is assumed distributed like the baseline airframe.
  for (const axis of ['x', 'y', 'z'] as const) sim.params.inertia[axis] = parameters.inertia[axis] * profile.mass / parameters.mass;
  sim.params.rotor.maxPitch = rad(profile.pitch);
  sim.params.motor.torquePercent = profile.motorTorque;
  // Scale the fixed reference, never the previously applied value.
  sim.params.rotor.collectiveGain = parameters.rotor.collectiveGain * profile.aerodynamics.liftGain / 100;
  sim.params.rotor.axialGain = parameters.rotor.axialGain * profile.aerodynamics.axialDamping / 100;
  sim.params.bodyDragScale = profile.aerodynamics.bodyDrag / 100;
  input.targetRPM = profile.rpm; input.rates = { ...profile.rates }; input.fbl = copyFbl(profile.fbl);
  sim.resetController();
}
