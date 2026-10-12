import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { replayRotor } from './recording-rotor-benchmark.ts';
import * as rotor from '../src/physics/rotor.ts';
import * as physics from '../src/physics/simulator.ts';
import { parameters } from '../src/physics/parameters.ts';
import { deg, clamp, vec, rad } from '../src/physics/math.ts';

const directory = resolve('analysis/response-calibration');
const reference = JSON.parse(readFileSync(`${directory}/reference.json`, 'utf8'));
const identified = JSON.parse(readFileSync('analysis/tron55-test/summary.json', 'utf8'));
const beforeRotor = await import(pathToFileURL(`${directory}/baseline/rotor.ts`).href);
const beforePhysics = await import(pathToFileURL(`${directory}/baseline/simulator.ts`).href);
const beforeParameters = (await import(pathToFileURL(`${directory}/baseline/parameters.ts`).href)).parameters;
const rms = (values: number[], target: number[], mask: boolean[]) => Math.sqrt(values.reduce((s, v, i) => s + (mask[i] ? (v - target[i]) ** 2 : 0), 0) / mask.filter(Boolean).length);
const versions = [
  { name: 'before', model: beforeRotor, physics: beforePhysics, parameters: beforeParameters },
  { name: 'calibrated', model: rotor, physics, parameters },
];
const force: any[] = [], vertical: any[] = [], rates: any[] = [];
for (const version of versions) {
  const { model } = version;
  for (const c of [{ name: 'reference', mass: 3.2, rpm: 2100, pitch: 13 },
    { name: 'saved-aircraft', mass: 5, rpm: 2400, pitch: 14 }]) {
    const p = structuredClone(version.parameters); p.rotor.maxPitch = rad(c.pitch);
    const result = replayRotor(reference.samples, c.mass, c.rpm, .002, p, model);
    force.push({ version: version.name, case: c, trainRms: rms(result.acceleration, reference.observed, reference.train),
      heldOutRms: rms(result.acceleration, reference.observed, reference.heldOut),
      allAirborneRms: rms(result.acceleration, reference.observed, reference.freeFlight),
      acceleration: result.acceleration });
    if (c.name !== 'reference') continue;
    // A free vertical prediction inside isolated upright pulses. Initialize once
    // per window; later measured velocities are NEVER fed back into the model.
    for (const [begin, end] of [[2.4, 3.8], [4.15, 5.25], [9.25, 10.65], [11.65, 13.1]]) {
      const first = reference.samples.findIndex((s: any) => s.t >= begin);
      const last = reference.samples.findIndex((s: any) => s.t >= end);
      let velocity = reference.velocity[first][1], height = reference.position[first][1];
      let inflow = result.wake[first], pitch = result.collectivePitch[first];
      const traces = [{ t: reference.samples[first].t, velocity, height }];
      for (let i = first + 1; i <= last; i++) {
        const a = reference.samples[i - 1], b = reference.samples[i];
        const count = Math.ceil((b.t - a.t) / .001), dt = (b.t - a.t) / count;
        for (let k = 1; k <= count; k++) {
          const target = (a.collective + (b.collective - a.collective) * k / count) * p.rotor.maxPitch;
          pitch += clamp(target - pitch, -p.controls.servoSpeed * dt, p.controls.servoSpeed * dt);
          const air = vec(0, velocity, 0), loads = model.rotorLoads(c.rpm * Math.PI / 30, pitch, inflow, air, p);
          inflow += (model.equilibriumInflow(loads.thrust, air, p) - inflow) * (1 - Math.exp(-dt / p.rotor.inflowTime));
          const drag = -.5 * p.density * p.dragArea.y * velocity * Math.abs(velocity) - .02 * velocity;
          const dv = ((loads.thrust + drag) / c.mass - p.gravity) * dt;
          height += (velocity + .5 * dv) * dt; velocity += dv;
        }
        traces.push({ t: b.t, velocity, height });
      }
      vertical.push({ version: version.name, first, last, begin, end, traces,
        velocityRms: Math.sqrt(traces.reduce((s, v, i) => s + (v.velocity - reference.velocity[first + i][1]) ** 2, 0) / traces.length),
        heightRms: Math.sqrt(traces.reduce((s, v, i) => s + (v.height - reference.position[first + i][1]) ** 2, 0) / traces.length) });
    }
  }
  // Match the recorded static rate curve before evaluating controller timing.
  // Isolated axis windows; this does not change the user's 350/620/40% settings.
  for (const [channel, bodyAxis, recordAxis, sign, begin, end] of [
    ['pitch', 'z', 2, -1, 15.5, 21.3], ['roll', 'x', 0, 1, 21.3, 24.25], ['yaw', 'y', 1, -1, 24.1, 29.5],
  ] as const) {
    const p = structuredClone(version.parameters); p.motor.torquePercent = 100;
    const sim = new version.physics.HelicopterSimulation(p), input = version.physics.defaultInput();
    input.collective = sim.hover(2100); input.motor = true; input.rates.expo = 0; sim.state.position.y = 1000;
    const staticFit = identified.rateFits[channel].scores.find((s: any) => s.lagMs === 0);
    const maximum = staticFit.linear + staticFit.cubic;
    input.rates[channel === 'yaw' ? 'yaw' : 'cyclic'] = maximum;
    const controlAxis = { pitch: 1, roll: 2, yaw: 3 }[channel];
    const first = reference.samples.findIndex((s: any) => s.t >= begin), last = reference.samples.findIndex((s: any) => s.t >= end);
    const traces = [];
    for (let i = first + 1; i <= last; i++) {
      const a = reference.samples[i - 1], b = reference.samples[i];
      const count = Math.ceil((b.t - a.t) / .002), dt = (b.t - a.t) / count;
      let integral = 0;
      for (let k = 1; k <= count; k++) {
        const u = reference.controls[i - 1][controlAxis] + (reference.controls[i][controlAxis] - reference.controls[i - 1][controlAxis]) * k / count;
        input[channel] = (staticFit.linear * u + staticFit.cubic * u ** 3) / maximum;
        const previous = sim.state.rates[bodyAxis]; sim.step(dt, input);
        integral += .5 * (previous + sim.state.rates[bodyAxis]) * dt;
      }
      const measured = deg(reference.omega[i - 1][recordAxis]) * (channel === 'pitch' ? -1 : 1);
      traces.push({ t: .5 * (a.t + b.t), measured, predicted: deg(integral / (b.t - a.t)) * sign });
    }
    const useful = traces.filter(v => v.t > begin + .2);
    rates.push({ version: version.name, channel, rms: Math.sqrt(useful.reduce((s, v) => s + (v.predicted - v.measured) ** 2, 0) / useful.length), traces });
  }
}
const output = { conditions: 'Before/after fixed-RPM force validation; first half fit, second half held out. Upright-window free vertical predictions are approximate and use one initial measured state. Axis replay matches static rate curve for diagnosis only.', force, vertical, rates };
writeFileSync(`${directory}/validation.json`, JSON.stringify(output) + '\n');
console.log(JSON.stringify({ force: force.map(({ acceleration, ...rest }) => rest),
  vertical: vertical.map(({ traces, ...rest }) => rest), rates: rates.map(({ traces, ...rest }) => rest) }, null, 2));
