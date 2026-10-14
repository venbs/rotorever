/** Deterministic load comparisons; never reads or writes a pilot's saved tune. */
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { applyAircraft } from '../src/aircraft-settings.ts';
import { benchmarkAircraft } from './benchmark-aircraft.ts';
import { HelicopterSimulation, defaultInput } from '../src/physics/simulator.ts';
import { deg, rad, vec } from '../src/physics/math.ts';
import { parameters } from '../src/physics/parameters.ts';
import { rotorLoads } from '../src/physics/rotor.ts';
import { maneuverLoads, rotorSeparationTarget } from '../src/physics/rotor-maneuver.ts';

export function maneuverExperiment(options: {
  enabled?: boolean; motor?: number; collective?: number; cyclic?: number;
  axis?: 'roll' | 'pitch'; dt?: number; activeSeconds?: number;
} = {}) {
  const { enabled = true, motor = 90, collective = 1, cyclic = 1, axis = 'pitch', dt = .002, activeSeconds = 1 } = options;
  const sim = new HelicopterSimulation(), input = defaultInput(), profile = benchmarkAircraft();
  profile.motorTorque = motor;
  applyAircraft(sim, input, profile);
  sim.params.rotor.maneuverLoadScale = enabled ? 1 : 0;
  input.motor = true;
  const trim = sim.hover(profile.rpm);
  sim.state.position.y = 1000;
  const stop = .2 + activeSeconds, traces = [];
  for (let k = 0; k < Math.round((stop + 1.8) / dt); k++) {
    const time = k * dt, active = time + 1e-9 >= .2 && time + 1e-9 < stop;
    input.collective = active ? collective : trim;
    input[axis] = active ? cyclic : 0;
    sim.step(dt, input);
    const s = sim.state;
    traces.push({ time: time + dt, active, rpm: s.rotorSpeed * 30 / Math.PI,
      mainLoad: s.aerodynamicTorque, motorTorque: s.motorTorque, addedTorque: s.maneuverTorque,
      separation: s.rotorSeparation, collective: deg(s.collective), cyclic: deg(s.cyclicPitch),
      thrust: s.thrust, rate: deg(s.rates[axis === 'roll' ? 'x' : 'z']), yaw: deg(s.rates.y) });
  }
  const active = traces.filter(t => t.active), end = traces.at(-1)!;
  return { enabled, motor, collective, cyclic, axis, dt, activeSeconds,
    minimumRPM: Math.min(...active.map(t => t.rpm)), peakLoad: Math.max(...active.map(t => t.mainLoad)),
    peakAddedTorque: Math.max(...active.map(t => t.addedTorque)), peakSeparation: Math.max(...active.map(t => t.separation)),
    peakRate: Math.max(...active.map(t => Math.abs(t.rate))), peakYaw: Math.max(...traces.map(t => Math.abs(t.yaw))),
    finalRPM: end.rpm, finalSeparation: end.separation, crashed: sim.state.crashed, traces };
}

/** Hold flow and RPM fixed to separate blade loading from subsequent aircraft motion. */
export function fixedFlowLoad(collectiveDegrees: number, cyclicDegrees: number) {
  const p = parameters, omega = 2400 * Math.PI / 30, inflow = 4, collective = rad(collectiveDegrees), cyclic = rad(cyclicDegrees);
  const base = rotorLoads(omega, collective, inflow, vec(), p);
  const separation = rotorSeparationTarget(omega, collective, cyclic, 0, inflow, p);
  const result = maneuverLoads(base, omega, collective, cyclic, 0, inflow, vec(0, 1, 0), vec(), separation, .002, p);
  return { collective: collectiveDegrees, cyclic: cyclicDegrees, thrust: result.thrust, torque: result.torque,
    separation, liftEfficiency: result.liftEfficiency, addedTorque: result.dragTorque + result.workTorque };
}

if (process.argv[1]?.endsWith('maneuver-load-benchmark.ts')) {
  const cases = [90, 100].flatMap(motor => [false, true].flatMap(enabled => [
    { collective: .25, cyclic: 1, axis: 'pitch' as const },
    { collective: 1, cyclic: 0, axis: 'pitch' as const },
    { collective: 1, cyclic: 1, axis: 'pitch' as const },
    { collective: 1, cyclic: 1, axis: 'roll' as const },
    { collective: -1, cyclic: -1, axis: 'pitch' as const },
  ].map(c => maneuverExperiment({ motor, enabled, ...c }))));
  const surface = [0, 6, 12].flatMap(collective => [0, 3, 6, 9, 12].map(cyclic => fixedFlowLoad(collective, cyclic)));
  console.table(cases.map(({ traces, ...c }) => Object.fromEntries(Object.entries(c).map(([k, v]) => [k, typeof v === 'number' ? +v.toFixed(3) : v]))));
  console.table(surface.map(c => Object.fromEntries(Object.entries(c).map(([k, v]) => [k, +v.toFixed(3)]))));
  // Report absolute local CPU time, not a rendering/FPS or old/new speed claim.
  for (let i = 0; i < 5; i++) maneuverExperiment();
  const start = performance.now();
  for (let i = 0; i < 40; i++) maneuverExperiment();
  const microsecondsPerStep = (performance.now() - start) * 1000 / (40 * 1500);
  const report = { conditions: { massKg: 5, rpm: 2400, collectiveLimitDeg: 12, cyclicRateDegS: 350,
    maneuverStartS: .2, maneuverDurationS: 1, recoveryS: 1.8, note: 'Scripted model regression, not HELI-X or real-flight validation.' },
    microsecondsPerStepIncludingTrace: microsecondsPerStep, cases, surface };
  console.log(`Local average including trace collection: ${microsecondsPerStep.toFixed(2)} microseconds / 2 ms step`);
  if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(report, null, 2) + '\n');
}
