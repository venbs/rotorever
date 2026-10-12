/** Deterministic physics-only experiments; never reads or changes browser settings. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { HelicopterSimulation, defaultInput } from '../src/physics/simulator.ts';
import { parameters } from '../src/physics/parameters.ts';
import { deg, rad } from '../src/physics/math.ts';
import { rotorLoads, equilibriumInflow } from '../src/physics/rotor.ts';

export interface Case {
  name: string; mass: number; rpm: number; motor: number;
  dt?: number; inflowTime?: number; servoSpeed?: number;
}
export function setup(c: Case) {
  const p = structuredClone(parameters);
  p.mass = c.mass;
  for (const axis of ['x', 'y', 'z'] as const) p.inertia[axis] *= c.mass / parameters.mass;
  p.motor.torquePercent = c.motor;
  p.rotor.inflowTime = c.inflowTime ?? p.rotor.inflowTime;
  p.controls.servoSpeed = rad(c.servoSpeed ?? 900);
  const sim = new HelicopterSimulation(p), input = defaultInput();
  input.motor = true; input.targetRPM = c.rpm; input.collective = sim.hover(c.rpm);
  sim.state.position.y = 100; // Exclude ground/contact forces.
  return { sim, input, trim: input.collective, dt: c.dt ?? 0.004 };
}
export function collectiveStep(c: Case, step: 'one-degree' | 'four-degrees' | 'full') {
  const { sim, input, trim, dt } = setup(c);
  const initialHeight = sim.state.position.y;
  const target = step === 'full' ? 1 : trim + rad(step === 'one-degree' ? 1 : 4) / sim.params.rotor.maxPitch;
  input.collective = target;
  let pitch99Ms: number | null = null;
  const traces = [];
  for (let n = 0; n <= Math.round(0.6 / dt); n++) {
    if (n > 0) sim.step(dt, input);
    const s = sim.state;
    if (n > 0 && pitch99Ms === null && Math.abs(s.collective / sim.params.rotor.maxPitch - target) <= Math.abs(target - trim) * 0.01) pitch99Ms = n * dt * 1000;
    traces.push({ ms: n * dt * 1000, commandDeg: target * deg(sim.params.rotor.maxPitch), pitchDeg: deg(s.collective),
      thrustN: s.thrust, acceleration: s.acceleration.y, velocity: s.velocity.y,
      height: s.position.y - initialHeight, rpm: s.rotorSpeed * 30 / Math.PI, inflow: s.inflow });
    if (s.crashed) throw new Error(`Unexpected contact/numerical failure in ${c.name}`);
  }
  const at = (ms: number) => traces[Math.round(ms / (dt * 1000))];
  return { case: c, step, trimDeg: trim * deg(sim.params.rotor.maxPitch), pitch99Ms,
    peakThrustFirst100ms: Math.max(...traces.filter(t => t.ms > 0 && t.ms <= 100).map(t => t.thrustN)),
    at100ms: at(100), at500ms: at(500), traces };
}
export function braking(c: Case, command: 'hover' | 'zero' | 'negative-half') {
  const { sim, input, trim, dt } = setup(c);
  input.collective = 0.5;
  for (let n = 0; n < Math.round(0.5 / dt); n++) sim.step(dt, input);
  const initialVelocity = sim.state.velocity.y;
  input.collective = command === 'hover' ? trim : command === 'zero' ? 0 : -0.5;
  let zeroCrossMs: number | null = null;
  const traces = [];
  for (let n = 0; n <= Math.round(1.5 / dt); n++) {
    if (n > 0) sim.step(dt, input);
    if (n > 0 && zeroCrossMs === null && sim.state.velocity.y <= 0) zeroCrossMs = n * dt * 1000;
    traces.push({ ms: n * dt * 1000, velocity: sim.state.velocity.y, acceleration: sim.state.acceleration.y,
      thrustN: sim.state.thrust, pitchDeg: deg(sim.state.collective) });
    if (sim.state.crashed) throw new Error(`Unexpected failure in braking ${c.name}`);
  }
  return { case: c, command, initialVelocity, zeroCrossMs, finalVelocity: sim.state.velocity.y, traces };
}

/** A fixed-air, steady rotor calculation, not a HELI-X-matched aircraft or free-flight trajectory. */
export function forceSurface(c: Case) {
  const { sim } = setup(c), p = sim.params, omega = c.rpm * Math.PI / 30;
  const rows = [];
  for (const pitchDeg of [2, 3, 4, 5, 6, 8, 10, 13]) {
    let inflow = 0;
    for (let n = 0; n < 4000; n++) {
      const loads = rotorLoads(omega, rad(pitchDeg), inflow, { x: 0, y: 0, z: 0 }, p);
      inflow += (equilibriumInflow(loads.thrust, { x: 0, y: 0, z: 0 }, p) - inflow) * 0.02;
    }
    const loads = rotorLoads(omega, rad(pitchDeg), inflow, { x: 0, y: 0, z: 0 }, p);
    rows.push({ pitchDeg, thrustN: loads.thrust, forcePerMass: loads.thrust / p.mass, inflow });
  }
  return { case: c, rows, gainBetween3and5Deg: (rows[3].forcePerMass - rows[1].forcePerMass) / 2 };
}

/** Isolate flow-state dynamics from climb-induced changes in blade angle of attack. */
export function fixedAirStep(c: Case) {
  const { sim, dt } = setup(c), p = sim.params, omega = c.rpm * Math.PI / 30;
  let pitch = sim.state.collective, inflow = sim.state.inflow;
  const traces = [];
  for (let n = 0; n <= Math.round(0.6 / dt); n++) {
    if (n > 0) pitch = Math.min(p.rotor.maxPitch, pitch + p.controls.servoSpeed * dt);
    const air = { x: 0, y: 0, z: 0 };
    const loads = rotorLoads(omega, pitch, inflow, air, p);
    if (n > 0) inflow += (equilibriumInflow(loads.thrust, air, p) - inflow) * (1 - Math.exp(-dt / p.rotor.inflowTime));
    traces.push({ ms: n * dt * 1000, pitchDeg: deg(pitch), thrustN: loads.thrust, inflow });
  }
  return { case: c, warning: 'Constrained rotor experiment: zero airspeed, fixed RPM; not a free-flight trajectory.', traces };
}

export function benchmark() {
  const configs: Case[] = [
    { name: 'default-finite', mass: 3.2, rpm: 2100, motor: 50 },
    { name: 'default-ideal', mass: 3.2, rpm: 2100, motor: 100 },
    { name: 'representative-finite', mass: 3.8, rpm: 2400, motor: 50 },
    { name: 'representative-ideal', mass: 3.8, rpm: 2400, motor: 100 },
  ];
  const ideal = configs[3];
  return {
    conditions: 'Physics only, no browser/gamepad/camera latency. Free flight from force-balanced hover at 100 m. Default FBL. Pitch ±13°. Representative is an explicit experiment, not a read of current user settings.',
    steps: configs.flatMap(c => (['one-degree', 'four-degrees', 'full'] as const).map(step => collectiveStep(c, step))),
    sensitivity: [ideal, { ...ideal, name: 'fast-inflow', inflowTime: 0.005 }, { ...ideal, name: 'fast-servo', servoSpeed: 90000 },
      { ...ideal, name: 'half-step', dt: 0.002 }, { ...ideal, name: 'quarter-step', dt: 0.001 }].map(c => collectiveStep(c, 'full')),
    braking: (['hover', 'zero', 'negative-half'] as const).map(command => braking(ideal, command)),
    forceSurfaces: [configs[1], ideal].map(forceSurface),
    fixedAir: fixedAirStep(ideal),
  };
}

if (process.argv[1]?.endsWith('collective-benchmark.ts')) {
  const destination = process.argv[2] ?? 'analysis/collective-benchmark.json';
  mkdirSync(dirname(destination), { recursive: true });
  const result = benchmark();
  writeFileSync(destination, JSON.stringify(result, null, 2) + '\n');
  console.table(result.steps.map(s => ({ case: s.case.name, step: s.step, pitch99Ms: s.pitch99Ms,
    a100: s.at100ms.acceleration.toFixed(2), v100: s.at100ms.velocity.toFixed(2), a500: s.at500ms.acceleration.toFixed(2), rpm500: s.at500ms.rpm.toFixed(0) })));
  console.log(`Saved ${destination}`);
}
