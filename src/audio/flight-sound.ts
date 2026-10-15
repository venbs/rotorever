import { add, clamp, dot, norm, rad, rotate, scale, vec, type Quat, type Vec3 } from '../physics/math.ts';
import type { FlightState } from '../physics/simulator.ts';
import type { Parameters } from '../physics/parameters.ts';
import { tailThrustLimit } from '../physics/tail.ts';

export interface SoundOperatingPoint { rpm: number; load: number; pitchLoad: number; yaw: number; yawRate: number; tailDrive: number; tailRatio: number }
export function soundOperatingPoint(s: FlightState, p: Parameters): SoundOperatingPoint {
  const rpm = Math.max(0, s.rotorSpeed * 30 / Math.PI);
  // Fixed physical pitch reference: editing maximum pitch must not retune a given blade angle.
  const pitchLoad = clamp(Math.hypot(s.collective, s.cyclicPitch * .4) / rad(12), 0, 1);
  // Acoustic effort is perceptual; keep actual angle linear for the motion detector.
  const load = Math.sqrt(pitchLoad);
  const limit = tailThrustLimit(s.rotorSpeed, p);
  // Negative force is the high anti-torque/right-piro direction in this body frame.
  const travel = limit > 1e-4 ? -s.tailForce / limit : 0;
  const trim = limit > 1e-4 ? s.mainRotorTorque / (p.tailArm * limit) : 0;
  return { rpm, load, pitchLoad, yaw: clamp((travel - trim) / .2, -1, 1), yawRate: -s.rates.y,
    tailDrive: clamp(travel / .2, -1.5, 1.5), tailRatio: p.tailRatio };
}

export interface SoundPose { position: Vec3; attitude: Quat }
export interface SoundGeometry {
  body: Vec3; main: Vec3; tail: Vec3; normal: Vec3;
  distances: { body: number; main: number; tail: number };
  gains: { body: number; main: number; tail: number };
  mainFacing: number;
}
export const soundReferenceDistance = 9;
export const mainEdgeGain = .3;
/** Pressure amplitude falloff. Near-field cap prevents a camera/source coincidence spike. */
export const distanceGain = (distance: number) => Math.min(1.5, soundReferenceDistance / Math.max(.5, distance));
export function mainFacingGain(normal: Vec3, towardCamera: Vec3, strength = 100) {
  const denominator = norm(normal) * norm(towardCamera);
  const cosine = denominator > 1e-9 ? clamp(Math.abs(dot(normal, towardCamera)) / denominator, 0, 1) : 1;
  return 1 - clamp(strength / 100, 0, 1) * (1 - mainEdgeGain) * (1 - cosine ** 1.5);
}
export function soundGeometry(pose: SoundPose, listener: Vec3, discRoll: number, discPitch: number, p: Parameters, directionStrength = 100): SoundGeometry {
  const body = { ...pose.position };
  const main = add(body, rotate(pose.attitude, vec(0, p.headHeight, 0)));
  // GLB tail shaft is 43.5 mm to the right of the boom centerline.
  const tail = add(body, rotate(pose.attitude, vec(-p.tailArm, p.tailHeight, .0435)));
  const disc = vec(Math.sin(discPitch), 1, Math.sin(discRoll));
  const normal = rotate(pose.attitude, scale(disc, 1 / norm(disc)));
  const relative = (v: Vec3) => add(listener, scale(v, -1));
  const distances = { body: norm(relative(body)), main: norm(relative(main)), tail: norm(relative(tail)) };
  const mainFacing = mainFacingGain(normal, relative(main), directionStrength);
  return { body, main, tail, normal, distances, mainFacing,
    gains: { body: distanceGain(distances.body), main: distanceGain(distances.main) * mainFacing, tail: distanceGain(distances.tail) } };
}

const smoothstep = (a: number, b: number, x: number) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
export const mainStrikeShape = (rate: number, acceleration: number) => {
  const speed = smoothstep(.65, 7, rate), snap = smoothstep(8, 140, acceleration);
  return { severity: clamp(.4 * speed + .6 * snap, 0, 1), snap };
};
// Body yaw acceleration (rad/s²), paired with speed change over the same short gesture.
// A sharp but tiny servo/gyro correction must not be made loud by a gain floor.
const tailAccelerationThreshold = rad(3500);
export function tailStrikeStrength(acceleration: number, speedChange: number) {
  return smoothstep(tailAccelerationThreshold, rad(22000), Math.abs(acceleration)) * smoothstep(rad(90), rad(400), Math.abs(speedChange));
}
export type RotorSoundEvent = { layer: 'main'; rate: number; acceleration: number } | { layer: 'tail'; strength: number; rising: boolean };
/** Read real servo motion at the existing physics timestep; no timers or input-event derivatives. */
export class RotorSoundMotion {
  private stage = 0; private position = 0; private velocity = 0; private active = false; private quiet = 0;
  private lastHit = -10; private pending: { start: number; rate: number; acceleration: number } | null = null;
  private lastYawRate = 0; private tailAcceleration = 0; private tailSign = 0; private tailQuiet = 0; private lastTail = -10;
  private tailPending: { start: number; origin: number; sign: number; acceleration: number; speedChange: number } | null = null;
  private time = 0; private initialized = false;
  reset(s?: SoundOperatingPoint) {
    this.stage = this.position = s?.pitchLoad ?? 0; this.velocity = 0; this.active = false; this.quiet = 0;
    this.pending = null; this.lastHit = -10; this.time = 0;
    this.lastYawRate = s?.yawRate ?? 0; this.tailAcceleration = 0; this.tailPending = null;
    this.tailSign = 0; this.tailQuiet = 0; this.lastTail = -10; this.initialized = Boolean(s);
  }
  step(s: SoundOperatingPoint, dt: number): RotorSoundEvent[] {
    if (!this.initialized || !(dt > 0 && dt <= .1) || s.rpm < 600) { this.reset(s); return []; }
    this.time += dt;
    const events: RotorSoundEvent[] = [], previous = this.position, velocity = this.velocity;
    this.stage += (s.pitchLoad - this.stage) * (1 - Math.exp(-dt / .026));
    this.position += (this.stage - this.position) * (1 - Math.exp(-dt / .035));
    const rate = (this.position - previous) / dt, acceleration = (rate - velocity) / dt;
    this.velocity = rate;
    if (rate > .8 && acceleration > 9 && !this.active && !this.pending && this.time - this.lastHit > .12) this.pending = { start: this.time, rate, acceleration };
    if (this.pending) {
      this.pending.rate = Math.max(this.pending.rate, rate); this.pending.acceleration = Math.max(this.pending.acceleration, acceleration);
      if (this.time - this.pending.start >= .028) {
        events.push({ layer: 'main', rate: this.pending.rate, acceleration: this.pending.acceleration });
        this.active = true; this.lastHit = this.time; this.pending = null;
      }
    }
    this.quiet = rate < .2 ? this.quiet + dt : 0;
    if (this.quiet > .045) this.active = false;

    // Gyro/body acceleration distinguishes a hard piro stop/reversal from ordinary
    // anti-torque feedforward and small, fast tail-servo corrections.
    const previousYawRate = this.lastYawRate;
    const yawAcceleration = (s.yawRate - previousYawRate) / dt;
    this.lastYawRate = s.yawRate;
    this.tailAcceleration += (yawAcceleration - this.tailAcceleration) * (1 - Math.exp(-dt / .012));
    const magnitude = Math.abs(this.tailAcceleration), sign = Math.sign(this.tailAcceleration);
    if (magnitude < rad(700)) {
      this.tailQuiet += dt;
      if (this.tailQuiet > .035) this.tailSign = 0;
    } else this.tailQuiet = 0;
    if (!this.tailPending && magnitude > tailAccelerationThreshold &&
        (this.tailSign === 0 || sign !== this.tailSign) && this.time - this.lastTail > .12) {
      this.tailPending = { start: this.time, origin: previousYawRate, sign, acceleration: magnitude, speedChange: 0 };
      this.tailSign = sign;
    }
    if (this.tailPending) {
      const p = this.tailPending;
      p.acceleration = Math.max(p.acceleration, this.tailAcceleration * p.sign);
      p.speedChange = Math.max(p.speedChange, (s.yawRate - p.origin) * p.sign);
      // Collect a short lobe: use its peak instead of firing on the first threshold
      // crossing, and emit at most once for the same acceleration/braking action.
      if (this.time - p.start >= .04) {
        const strength = tailStrikeStrength(p.acceleration, p.speedChange);
        if (strength >= .025) {
          events.push({ layer: 'tail', strength, rising: p.sign > 0 });
          this.lastTail = this.time;
        }
        this.tailPending = null;
      }
    }
    return events;
  }
}
