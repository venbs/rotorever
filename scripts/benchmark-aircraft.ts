import type { AircraftProfile } from '../src/aircraft-settings.ts';
import { defaultFbl } from '../src/physics/fbl.ts';

/** Fixed regression conditions from the original response reports. Keep independent
 * of the pilot's evolving application defaults so before/after results stay comparable. */
export const benchmarkAircraft = (): AircraftProfile => ({
  mass: 5, rpm: 2400, motorTorque: 90, pitch: 12,
  rates: { cyclic: 350, yaw: 650, expo: 0.4 }, fbl: defaultFbl(),
  aerodynamics: { liftGain: 100, axialDamping: 100, bodyDrag: 100 },
});
