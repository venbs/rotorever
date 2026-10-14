/** Aggressive, deterministic stick sequences. Never reads or writes saved pilot settings. */
import { HelicopterSimulation, defaultInput } from '../src/physics/simulator.ts';
import { applyAircraft } from '../src/aircraft-settings.ts';
import { benchmarkAircraft } from './benchmark-aircraft.ts';
import { deg, rotate, vec } from '../src/physics/math.ts';
import { writeFileSync } from 'node:fs';
export function tailExperiment(options: {
  motor?: number; lift?: number; damping?: number; drag?: number; dt?: number;
  scenario?: 'pumps' | 'piro-left' | 'piro-right' | 'mixed'; duration?: number; pumpPeriod?: number;
  Simulation?: typeof HelicopterSimulation;
} = {}) {
  const { motor = 90, lift = 120, damping = 130, drag = 100, dt = .002, scenario = 'pumps', duration = 8, pumpPeriod = .16, Simulation = HelicopterSimulation } = options;
  const sim = new Simulation(), input = defaultInput(), profile = benchmarkAircraft();
  profile.motorTorque = motor; profile.aerodynamics = { liftGain: lift, axialDamping: damping, bodyDrag: drag };
  applyAircraft(sim, input, profile); input.motor = true; input.collective = sim.hover(profile.rpm);
  sim.state.position.y = 1000;
  let previousHeading = 0, heading = 0, steadyErrors: number[] = [], neutralRates: number[] = [];
  const traces = [];
  for (let k = 0; k < Math.round(duration / dt); k++) {
    const time = k * dt, phase = time % 2;
    // Alternating ±12°; 160 ms strokes by default. Scripted, not a pilot recording.
    input.collective = Math.floor((time + 1e-9) / pumpPeriod) % 2 ? -1 : 1;
    input.yaw = scenario === 'pumps' ? 0 : phase >= .3 && phase < 1.3 ? (scenario === 'piro-left' ? -1 : 1) : 0;
    if (scenario === 'mixed') {
      input.roll = .8 * Math.sin(2 * Math.PI * .8 * time);
      input.pitch = .8 * Math.cos(2 * Math.PI * .8 * time);
    }
    sim.step(dt, input);
    const s = sim.state, forward = rotate(s.attitude, vec(1, 0, 0));
    const angle = Math.atan2(forward.z, forward.x);
    heading += Math.atan2(Math.sin(angle - previousHeading), Math.cos(angle - previousHeading)); previousHeading = angle;
    const yaw = deg(s.rates.y), target = deg(s.rateTarget.y);
    if (input.yaw !== 0 && phase >= .5 && phase < 1.3) steadyErrors.push(Math.abs(yaw - target));
    if (input.yaw === 0 && (phase < .3 || phase >= 1.5)) neutralRates.push(Math.abs(yaw));
    traces.push({ time: time + dt, rpm: s.rotorSpeed * 30 / Math.PI, yaw, target, heading: deg(heading),
      torque: s.motorTorque, mainTorque: 'mainRotorTorque' in s ? Number(s.mainRotorTorque) : s.motorTorque,
      tailForce: s.tailForce, saturated: s.pid.yaw.saturated, pitch: deg(s.collective), height: s.position.y });
  }
  return { motor, lift, damping, drag, scenario, dt, duration, pumpPeriod,
    minRPM: Math.min(...traces.map(t => t.rpm)), maxYaw: Math.max(...traces.map(t => Math.abs(t.yaw))),
    maxHeading: Math.max(...traces.map(t => Math.abs(t.heading))),
    peakSteadyError: Math.max(0, ...steadyErrors), peakNeutralRate: Math.max(0, ...neutralRates),
    saturatedMs: traces.filter(t => t.saturated).length * dt * 1000,
    crashed: sim.state.crashed, traces };
}
if (process.argv[1]?.endsWith('tail-response-benchmark.ts')) {
  const cases = [90, 100].flatMap(motor => [
    { lift: 100, damping: 100, drag: 100 }, { lift: 120, damping: 130, drag: 100 }, { lift: 200, damping: 100, drag: 200 },
  ].flatMap(tune => (['pumps', 'piro-left', 'piro-right', 'mixed'] as const).map(scenario => tailExperiment({ motor, ...tune, scenario }))));
  console.table(cases.map(({ traces, ...c }) => Object.fromEntries(Object.entries(c).map(([k,v]) => [k, typeof v === 'number' ? +v.toFixed(k === 'dt' ? 3 : 2) : v]))));
  if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(cases, null, 2) + '\n');
}
