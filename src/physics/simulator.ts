import { add, axisAngle, clamp, conjugate, cross, dot, identity, integrateAttitude, lag, norm, rotate, scale, vec, type Quat, type Vec3 } from './math.ts';
import { parameters, type Parameters } from './parameters.ts';
import { equilibriumInflow, hoverTrim, rotorLoads } from './rotor.ts';
import { defaultRates, rateCommand, type RateProfile } from './rates.ts';
import { defaultFbl, zeroPidTerms, type FblProfile, type PidTerms, type FblAxis } from './fbl.ts';
import { field } from '../field.ts';

export interface FlightInput {
  collective: number; roll: number; pitch: number; yaw: number;
  motor: boolean; targetRPM: number; assist: boolean; wind: number; rates: RateProfile; fbl: FblProfile;
}
export const defaultInput = (): FlightInput => ({ collective: 0, roll: 0, pitch: 0, yaw: 0, motor: false, targetRPM: 2100, assist: false, wind: 0, rates: defaultRates(), fbl: defaultFbl() });
export interface FlightState {
  position: Vec3; velocity: Vec3; attitude: Quat; rates: Vec3;
  rotorSpeed: number; rotorPhase: number; inflow: number;
  collective: number; discRoll: number; discPitch: number; tailForce: number;
  motorTorque: number; thrust: number; aerodynamicTorque: number;
  acceleration: Vec3; thrustWorld: Vec3; windWorld: Vec3;
  rateTarget: Vec3;
  pid: Record<FblAxis, PidTerms>;
  time: number; grounded: boolean; crashed: boolean;
}
export class HelicopterSimulation {
  readonly params: Parameters;
  state!: FlightState;
  private rateIntegral = vec();
  private governorIntegral = 0;
  private governorSetpoint = 0;
  private servoRoll = 0;
  private servoPitch = 0;
  private lastRates = vec();
  private lastTarget = vec();
  private filteredDerivative = vec();
  private filteredBoost = vec();
  private relaxTarget = vec();
  constructor(params: Parameters = parameters) { this.params = structuredClone(params); this.reset(); }

  reset() {
    this.state = {
      position: vec(0, field.groundY + this.params.skidHeight + 0.002, 0), velocity: vec(), attitude: identity(), rates: vec(),
      rotorSpeed: 0, rotorPhase: 0, inflow: 0, collective: 0, discRoll: 0, discPitch: 0, tailForce: 0,
      motorTorque: 0, thrust: 0, aerodynamicTorque: 0,
      acceleration: vec(), thrustWorld: vec(), windWorld: vec(), rateTarget: vec(),
      pid: { roll: zeroPidTerms(), pitch: zeroPidTerms(), yaw: zeroPidTerms() }, time: 0, grounded: true, crashed: false,
    };
    this.rateIntegral = vec(); this.governorIntegral = 0; this.governorSetpoint = 0;
    this.servoRoll = 0; this.servoPitch = 0;
    this.resetController();
  }

  /** Applying a tune clears stored controller energy, without resetting the aircraft. */
  resetController() {
    this.rateIntegral = vec();
    this.lastRates = { ...this.state.rates }; this.lastTarget = { ...this.state.rateTarget };
    this.relaxTarget = { ...this.state.rateTarget };
    this.filteredDerivative = vec(); this.filteredBoost = vec();
  }

  private tailLoad(force: number, omega: number) {
    const rpmRatio = omega / (2100 * Math.PI / 30);
    const power = Math.abs(force) ** 1.5 / Math.sqrt(2 * this.params.density * Math.PI * 0.105 ** 2) / 0.72 + 16 * rpmRatio ** 3;
    return power / Math.max(omega, 20);
  }

  /** Reset to a force-balanced initial condition. No altitude or position hold is used. */
  hover(targetRPM = 2100): number {
    this.reset();
    const s = this.state, p = this.params;
    const omega = targetRPM * Math.PI / 30, weight = p.mass * p.gravity;
    let tail = 0, trim = hoverTrim(omega, weight, p), torque = trim.torque;
    for (let i = 0; i < 20; i++) {
      trim = hoverTrim(omega, Math.sqrt(Math.max(1, weight * weight - tail * tail)), p);
      torque = trim.torque + p.motor.friction + this.tailLoad(tail, omega);
      tail = -torque / p.tailArm;
    }
    const bank = Math.atan2(-tail, trim.thrust);
    s.position.y = 1.5;
    s.attitude = axisAngle(vec(1, 0, 0), bank);
    s.rotorSpeed = omega; s.collective = trim.pitch; s.inflow = trim.inflow;
    s.thrust = trim.thrust; s.aerodynamicTorque = trim.torque;
    s.motorTorque = torque; s.tailForce = tail; s.grounded = false;
    s.thrustWorld = rotate(s.attitude, vec(0, s.thrust, 0));
    this.governorSetpoint = omega;
    this.governorIntegral = torque / (p.motor.ki * clamp(p.motor.torquePercent, 10, 100) / 50);
    return trim.pitch / p.rotor.maxPitch;
  }

  step(dt: number, input: FlightInput) {
    if (!(dt > 0 && dt <= 0.01)) throw new Error('Physics step must be in (0, 0.01] seconds.');
    // Bound integration error for the stronger calibrated rotor and fast FBL.
    // The O(1) flight rotor model leaves room for 500 Hz internal dynamics.
    const count = Math.ceil(dt / .002), h = dt / count;
    for (let i = 0; i < count && !this.state.crashed; i++) this.integrateStep(h, input);
  }

  private integrateStep(dt: number, input: FlightInput) {
    const s = this.state, p = this.params;
    if (s.crashed) return;
    s.time += dt;
    const inverse = conjugate(s.attitude);
    const wind = Math.max(0, input.wind);
    s.windWorld = vec(wind * 0.15 * Math.sin(s.time * 0.67), 0, wind * (1 + 0.12 * Math.sin(s.time * 0.39)));
    const air = rotate(inverse, add(s.velocity, scale(s.windWorld, -1)));
    const rpmRatio = s.rotorSpeed / (2100 * Math.PI / 30);

    // Flight controller: attitude assist feeds the same body-rate loop as rate mode.
    const up = rotate(inverse, vec(0, 1, 0));
    const roll = Math.atan2(-up.z, up.y), pitch = Math.atan2(up.x, Math.hypot(up.y, up.z));
    const weight = p.mass * p.gravity;
    const trimBank = Math.atan2(-s.tailForce, Math.sqrt(Math.max(1, weight * weight - s.tailForce * s.tailForce)));
    const cyclicLimit = input.rates.cyclic * Math.PI / 180;
    const desired = s.rateTarget = vec(
      input.assist ? clamp((input.roll * p.controls.maxAssistTilt + trimBank - roll) * 4, -cyclicLimit, cyclicLimit) : rateCommand(input.roll, input.rates.cyclic, input.rates.expo),
      -rateCommand(input.yaw, input.rates.yaw, input.rates.expo),
      input.assist ? clamp((-input.pitch * p.controls.maxAssistTilt - pitch) * 4, -cyclicLimit, cyclicLimit) : -rateCommand(input.pitch, input.rates.cyclic, input.rates.expo),
    );
    const error = add(desired, scale(s.rates, -1));
    // PID + steady-rate FF + filtered setpoint-acceleration Boost. Each term
    // produces torque, then drives the finite actuators; never assign body rates.
    const momentum = vec(p.inertia.x * s.rates.x, p.inertia.y * s.rates.y, p.inertia.z * s.rates.z);
    const coupling = cross(s.rates, momentum);
    const requestedMoment = vec();
    const cyclicAuthority = Math.max(0.1, p.hubStiffness * rpmRatio ** 2 + p.headHeight * s.thrust);
    const tune = input.fbl;
    for (const [a, channel] of [['x', 'roll'], ['y', 'yaw'], ['z', 'pitch']] as const) {
      const gain = tune[channel], terms = s.pid[channel];
      this.filteredDerivative[a] = lag(this.filteredDerivative[a], (s.rates[a] - this.lastRates[a]) / dt, 1 / (2 * Math.PI * tune.dCutoff), dt);
      this.filteredBoost[a] = lag(this.filteredBoost[a], (desired[a] - this.lastTarget[a]) / dt, 1 / (2 * Math.PI * tune.bCutoff), dt);
      this.relaxTarget[a] = lag(this.relaxTarget[a], desired[a], 1 / (2 * Math.PI * tune.relaxCutoff), dt);
      this.lastRates[a] = s.rates[a]; this.lastTarget[a] = desired[a];
      terms.p = p.inertia[a] * gain.p * error[a];
      terms.d = -p.inertia[a] * gain.d * this.filteredDerivative[a];
      terms.ff = gain.ff / 100 * p.angularDamping[a] * desired[a];
      terms.b = p.inertia[a] * gain.b / 100 * this.filteredBoost[a];
      const torque = () => terms.p + p.inertia[a] * gain.i * this.rateIntegral[a] + terms.d + terms.ff + terms.b + coupling[a];
      const limit = a === 'y' ? p.tailMaxForce * rpmRatio ** 2 * p.tailArm : cyclicAuthority * p.rotor.maxDiscTilt;
      const demand = torque() - (a === 'y' ? s.motorTorque : 0);
      // Conditional integration avoids storing a large error while an actuator is saturated.
      if (!s.grounded && rpmRatio > 0.3) {
        // Suppress new I charge during fast stick changes; always allow unwinding.
        const relax = clamp(1 - Math.abs(desired[a] - this.relaxTarget[a]) / (40 * Math.PI / 180), 0, 1);
        if (Math.abs(demand) < limit || demand * error[a] < 0) {
          const factor = error[a] * this.rateIntegral[a] < 0 ? 1 : relax;
          this.rateIntegral[a] = clamp(this.rateIntegral[a] + error[a] * dt * factor, -0.4, 0.4);
        }
      } else this.rateIntegral[a] = 0;
      if (gain.i === 0) this.rateIntegral[a] = 0;
      terms.i = p.inertia[a] * gain.i * this.rateIntegral[a];
      requestedMoment[a] = torque();
      terms.saturated = Math.abs(requestedMoment[a] - (a === 'y' ? s.motorTorque : 0)) >= limit;
    }
    const cyclicRoll = clamp(requestedMoment.x / cyclicAuthority + s.rates.x * p.rotor.flapRateTime, -p.rotor.maxDiscTilt, p.rotor.maxDiscTilt);
    const cyclicPitch = clamp(-requestedMoment.z / cyclicAuthority - s.rates.z * p.rotor.flapRateTime, -p.rotor.maxDiscTilt, p.rotor.maxDiscTilt);
    const servo = (current: number, target: number) => current + clamp(target - current, -p.controls.servoSpeed * dt, p.controls.servoSpeed * dt);
    s.collective = servo(s.collective, clamp(input.collective, -1, 1) * p.rotor.maxPitch);
    this.servoRoll = servo(this.servoRoll, cyclicRoll);
    this.servoPitch = servo(this.servoPitch, cyclicPitch);
    s.discRoll = lag(s.discRoll, this.servoRoll - s.rates.x * p.rotor.flapRateTime, p.rotor.discTime, dt);
    s.discPitch = lag(s.discPitch, this.servoPitch + s.rates.z * p.rotor.flapRateTime, p.rotor.discTime, dt);
    const disc = vec(Math.sin(s.discPitch), 1, Math.sin(s.discRoll));
    const discNormal = scale(disc, 1 / norm(disc));
    const axial = dot(air, discNormal);
    const discAir = vec(Math.sqrt(Math.max(0, dot(air, air) - axial * axial)), axial, 0);
    const loads = rotorLoads(s.rotorSpeed, s.collective, s.inflow, discAir, p);
    // Uniform inflow responds dynamically to loading, instead of instantly jumping.
    s.inflow = lag(s.inflow, equilibriumInflow(loads.thrust, discAir, p), p.rotor.inflowTime, dt);
    s.thrust = loads.thrust;
    s.aerodynamicTorque = loads.torque;

    // 50% preserves the original motor. 100% is an explicit ideal governor,
    // supplying/absorbing the shaft torque needed to hold RPM under any load.
    const requestedRPM = clamp(input.targetRPM, 1200, 3000);
    const spoolRate = (2100 * Math.PI / 30) / p.motor.spoolTime;
    this.governorSetpoint = input.motor ? Math.min(requestedRPM * Math.PI / 30, this.governorSetpoint + spoolRate * dt) : 0;
    const strength = clamp(p.motor.torquePercent, 10, 100) / 50;
    const kp = p.motor.kp * strength, ki = p.motor.ki * strength;
    const rpmError = this.governorSetpoint - s.rotorSpeed;
    const torqueLimit = strength * Math.min(p.motor.maxTorque, p.motor.maxPower / Math.max(s.rotorSpeed, 30));
    const maxTail = p.tailMaxForce * rpmRatio * rpmRatio;
    const tailForTorque = (torque: number) => lag(s.tailForce, clamp((requestedMoment.y - torque) / p.tailArm, -maxTail, maxTail), p.tailResponseTime, dt);
    const friction = s.rotorSpeed > 0 ? p.motor.friction : 0;
    if (input.motor && p.motor.torquePercent >= 100) {
      // Ramp startup, in-flight RPM changes, and recovery when enabling this mode.
      // Once at target, load changes cannot reduce the rotor speed.
      const nextSpeed = s.rotorSpeed + clamp(rpmError, -spoolRate * dt, spoolRate * dt);
      const shaftTorque = loads.torque + friction + p.rotor.inertia * (nextSpeed - s.rotorSpeed) / dt;
      let torque = shaftTorque + this.tailLoad(s.tailForce, s.rotorSpeed);
      // Tail power depends on the motor's reaction torque: solve them together.
      for (let i = 0; i < 10; i++) torque = shaftTorque + this.tailLoad(tailForTorque(torque), s.rotorSpeed);
      s.tailForce = tailForTorque(torque);
      s.motorTorque = shaftTorque + this.tailLoad(s.tailForce, s.rotorSpeed);
      this.governorIntegral = clamp((s.motorTorque - kp * rpmError) / ki, 0, torqueLimit / ki);
      s.rotorSpeed = nextSpeed;
    } else {
      const demand = kp * rpmError + ki * this.governorIntegral;
      if (input.motor && ((demand > 0 && demand < torqueLimit) || (demand >= torqueLimit && rpmError < 0) || (demand <= 0 && rpmError > 0))) {
        this.governorIntegral = clamp(this.governorIntegral + rpmError * dt, 0, p.motor.maxTorque * strength / ki);
      }
      if (!input.motor) this.governorIntegral = 0;
      s.motorTorque = lag(s.motorTorque, input.motor ? clamp(kp * rpmError + ki * this.governorIntegral, 0, torqueLimit) : 0, p.motor.responseTime / strength, dt);
      s.tailForce = tailForTorque(s.motorTorque);
      const tailTorque = this.tailLoad(s.tailForce, s.rotorSpeed);
      s.rotorSpeed = Math.max(0, s.rotorSpeed + (s.motorTorque - loads.torque - tailTorque - friction) / p.rotor.inertia * dt);
    }
    s.rotorPhase = (s.rotorPhase + s.rotorSpeed * dt) % (Math.PI * 2);

    const rotorForce = scale(discNormal, loads.thrust);
    const tailForce = vec(0, 0, s.tailForce);
    const drag = vec();
    for (const a of ['x', 'y', 'z'] as const) drag[a] = -0.5 * p.density * p.dragArea[a] * air[a] * Math.abs(air[a]) - 0.02 * air[a];
    let force = add(rotate(s.attitude, add(add(rotorForce, tailForce), drag)), vec(0, -p.mass * p.gravity, 0));
    let moment = add(cross(vec(0, p.headHeight, 0), rotorForce), cross(vec(-p.tailArm, p.tailHeight, 0), tailForce));
    moment = add(moment, vec(p.hubStiffness * s.discRoll * rpmRatio ** 2, s.motorTorque, -p.hubStiffness * s.discPitch * rpmRatio ** 2));
    for (const a of ['x', 'y', 'z'] as const) moment[a] -= p.angularDamping[a] * s.rates[a];

    // Four skid contacts: spring/damper normal force and regularized Coulomb friction.
    s.grounded = false;
    let minContact = Infinity;
    for (const x of [-0.15, 0.15]) for (const z of [-0.078, 0.078]) {
      const local = vec(x, -p.skidHeight, z);
      const offset = rotate(s.attitude, local);
      const height = s.position.y + offset.y - field.groundY;
      minContact = Math.min(minContact, height);
      if (height >= 0) continue;
      const velocity = add(s.velocity, rotate(s.attitude, cross(s.rates, local)));
      if (velocity.y < -2.8 || up.y < 0.55 || height < -0.15) { s.crashed = true; return; }
      s.grounded = true;
      const normal = Math.max(0, -height * 2200 - velocity.y * 42);
      const speed = Math.hypot(velocity.x, velocity.z);
      const frictionScale = -0.65 * normal / Math.max(speed, 0.12);
      const contact = vec(velocity.x * frictionScale, normal, velocity.z * frictionScale);
      force = add(force, contact);
      moment = add(moment, cross(local, rotate(inverse, contact)));
    }
    const worldUp = rotate(s.attitude, vec(0, 1, 0));
    const head = add(s.position, scale(worldUp, p.headHeight));
    if (head.y - p.rotor.radius * Math.hypot(worldUp.x, worldUp.z) < field.groundY && s.rotorSpeed > 20) { s.crashed = true; return; }

    s.thrustWorld = rotate(s.attitude, rotorForce);
    s.acceleration = scale(force, 1 / p.mass);
    s.velocity = add(s.velocity, scale(s.acceleration, dt));
    s.position = add(s.position, scale(s.velocity, dt));
    const angularMomentum = vec(p.inertia.x * s.rates.x, p.inertia.y * s.rates.y, p.inertia.z * s.rates.z);
    const rhs = add(moment, scale(cross(s.rates, angularMomentum), -1));
    const newRates = add(s.rates, vec(rhs.x / p.inertia.x * dt, rhs.y / p.inertia.y * dt, rhs.z / p.inertia.z * dt));
    s.attitude = integrateAttitude(s.attitude, scale(add(s.rates, newRates), 0.5), dt);
    s.rates = newRates;
    if (!Number.isFinite(norm(s.position) + norm(s.rates)) || norm(s.rates) > 150 || minContact < -0.2) s.crashed = true;
  }
}

/** Rendering never changes physics dt. Long frames discard excess wall time, not integrate a giant step. */
export class FixedStepClock {
  readonly dt = 1 / 250;
  accumulator = 0;
  droppedTime = 0;
  advance(elapsed: number, step: (dt: number) => void) {
    const accepted = clamp(elapsed, 0, 0.1);
    this.droppedTime += Math.max(0, elapsed - accepted);
    this.accumulator += accepted;
    let steps = 0;
    while (this.accumulator + 1e-10 >= this.dt && steps < 25) {
      step(this.dt);
      this.accumulator = Math.max(0, this.accumulator - this.dt);
      steps++;
    }
    return this.accumulator / this.dt;
  }
  reset() { this.accumulator = 0; this.droppedTime = 0; }
}
