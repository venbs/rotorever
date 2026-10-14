import { clamp, lag, type Vec3 } from './math.ts';
import type { Parameters } from './parameters.ts';
import type { RotorLoads } from './rotor.ts';

// A weighted representative span, eight azimuths, one separation state. This is
// an effective maneuver correction to the identified rotor, not resolved CFD,
// structural blade folding, a BVI sound model, or a measured dynamic-stall polar.
const azimuthCosines = Array.from({ length: 8 }, (_, i) => Math.cos(i * Math.PI / 4));
export function bladeCyclicPitch(servoRoll: number, servoPitch: number, rates: Vec3, omega: number, p: Parameters) {
  // The old FBL plant controls disc tilt. Approximate the extra blade incidence
  // needed to follow a rotating mast using body-rate / rotor-rate, not raw stick.
  const tracking = p.rotor.cyclicTrackingGain * Math.hypot(rates.x, rates.z) / Math.max(omega, 40);
  return Math.min(p.rotor.maxCyclicPitch, Math.hypot(servoRoll, servoPitch) + tracking);
}

export function rotorSeparationTarget(omega: number, collective: number, cyclic: number, axial: number, inflow: number, p: Parameters) {
  const phi = Math.atan2(axial + inflow, Math.max(omega * .75 * p.rotor.radius, 1));
  let separation = 0;
  for (const cosine of azimuthCosines) {
    const alpha = collective + cyclic * cosine - phi;
    const excess = clamp((Math.abs(alpha) - p.rotor.stallAngle) / p.rotor.stallWidth, 0, 1);
    separation += excess * excess * (3 - 2 * excess);
  }
  return separation / azimuthCosines.length;
}

export function maneuverLoads(base: RotorLoads, omega: number, collective: number, cyclic: number,
  axial: number, inflow: number, disc: Vec3, rates: Vec3, previousSeparation: number, dt: number, p: Parameters) {
  const r = p.rotor;
  const target = rotorSeparationTarget(omega, collective, cyclic, axial, inflow, p);
  const separation = lag(previousSeparation, target, target > previousSeparation ? r.separationAttack : r.separationRecovery, dt);
  const flightBlend = clamp((omega - 40) / 40, 0, 1);
  const effect = flightBlend * r.maneuverLoadScale;
  const liftEfficiency = 1 - effect * r.stallLiftLoss * separation;
  const cyclicEfficiency = 1 - effect * r.stallCyclicLoss * separation;
  const thrust = base.thrust * liftEfficiency;
  // Added attached-flow profile drag from periodic incidence: mean(theta1² cos²)
  // = theta1²/2. The existing collective-only power estimate is retained. The
  // separated-flow term supplies the nonlinear collective/cyclic interaction.
  const extraCd = .018 * .5 * (r.liftSlope * cyclic) ** 2 + r.stallDrag * separation;
  const profileFactor = r.blades * p.density * r.chord * (r.radius ** 4 - r.root ** 4) / 8 * omega ** 2;
  const dragTorque = effect * profileFactor * extraCd;
  const hub = p.hubStiffness * (omega / (2100 * Math.PI / 30)) ** 2 * cyclicEfficiency;
  // Include positive work delivered to roll/pitch. Negative work is dissipated
  // rather than treated as an unmodeled regenerative mechanism.
  // The plant constructs discNormal from [sin(pitch), 1, sin(roll)]. Recover
  // those exact angles so this work uses the same moments as the rigid body.
  const rollMoment = p.headHeight * thrust * disc.z + hub * Math.asin(clamp(disc.z / disc.y, -1, 1));
  const pitchMoment = -p.headHeight * thrust * disc.x - hub * Math.asin(clamp(disc.x / disc.y, -1, 1));
  const workTorque = effect * Math.max(0, rollMoment * rates.x + pitchMoment * rates.z) / Math.max(omega, 40);
  // Recompute the useful axial power after lift loss; don't charge both the old
  // and new thrust. Additional shaft drag is non-negative even in windmilling.
  const torque = base.torque + (thrust - base.thrust) * (axial + inflow) / Math.max(omega, 1) + dragTorque + workTorque;
  return { thrust, torque, separation, liftEfficiency, cyclicEfficiency, dragTorque, workTorque };
}
