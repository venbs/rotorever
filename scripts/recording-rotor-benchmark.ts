/** Prescribed-airflow rotor benchmark, not a free-flight or HELI-X physics replay.
 * Feed recorded collective and body velocity into our independent rotor model.
 * Fixed RPM removes governor droop. Wind, disc tilt and unknown HELI-X settings
 * are not inferred. Input is a derived local analysis file, never an app setting.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parameters, type Parameters } from '../src/physics/parameters.ts';
import { equilibriumInflow, rotorLoads } from '../src/physics/rotor.ts';
import { clamp, rad, vec } from '../src/physics/math.ts';

interface Sample { t: number; collective: number; bodyVelocity: number[] }
export function replayRotor(samples: Sample[], mass: number, rpm: number, maxDt = .004, profile: Parameters = parameters,
  model = { rotorLoads, equilibriumInflow }) {
  if (!(maxDt > 0 && maxDt <= .01) || samples.length < 2) throw new Error('Invalid benchmark input');
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    if (s.bodyVelocity.length !== 3 || ![s.t, s.collective, ...s.bodyVelocity].every(Number.isFinite)
      || (i > 0 && s.t <= samples[i - 1].t)) throw new Error('Invalid recording sample');
  }
  const p = structuredClone(profile);
  p.mass = mass;
  const omega = rpm * Math.PI / 30;
  let pitch = samples[0].collective * p.rotor.maxPitch, inflow = 0;
  const firstAir = vec(...samples[0].bodyVelocity as [number, number, number]);
  for (let i = 0; i < 4000; i++) {
    const loads = model.rotorLoads(omega, pitch, inflow, firstAir, p);
    inflow += .02 * (model.equilibriumInflow(loads.thrust, firstAir, p) - inflow);
  }
  const normal = (thrust: number, axial: number) =>
    (thrust - .5 * p.density * p.dragArea.y * axial * Math.abs(axial) - .02 * axial) / mass;
  const acceleration = [normal(model.rotorLoads(omega, pitch, inflow, firstAir, p).thrust, firstAir.y)];
  const wake = [inflow], collectivePitch = [pitch];
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i];
    const steps = Math.ceil((b.t - a.t) / maxDt), dt = (b.t - a.t) / steps;
    let value = 0;
    for (let j = 1; j <= steps; j++) {
      const mix = j / steps;
      const target = (a.collective + (b.collective - a.collective) * mix) * p.rotor.maxPitch;
      pitch += clamp(target - pitch, -p.controls.servoSpeed * dt, p.controls.servoSpeed * dt);
      const velocity = a.bodyVelocity.map((v, k) => v + (b.bodyVelocity[k] - v) * mix);
      const air = vec(...velocity as [number, number, number]);
      const loads = model.rotorLoads(omega, pitch, inflow, air, p);
      inflow += (model.equilibriumInflow(loads.thrust, air, p) - inflow) * (1 - Math.exp(-dt / p.rotor.inflowTime));
      value = normal(loads.thrust, air.y);
    }
    acceleration.push(value);
    wake.push(inflow); collectivePitch.push(pitch);
  }
  if (!acceleration.every(Number.isFinite)) throw new Error('Non-finite rotor output');
  return { mass, rpm, maxPitchDeg: p.rotor.maxPitch / rad(1), maxDt, acceleration, wake, collectivePitch };
}

if (process.argv[1]?.endsWith('recording-rotor-benchmark.ts')) {
  const [source, destination] = process.argv.slice(2);
  if (!source || !destination) throw new Error('Usage: recording-rotor-benchmark.ts input.json output.json');
  const { samples } = JSON.parse(readFileSync(source, 'utf8')) as { samples: Sample[] };
  const cases = [
    { name: 'default-ideal', ...replayRotor(samples, 3.2, 2100) },
    { name: 'representative-ideal', ...replayRotor(samples, 3.8, 2400) },
    { name: 'representative-half-step', ...replayRotor(samples, 3.8, 2400, .002) },
  ];
  writeFileSync(destination, JSON.stringify({ conditions: 'Recorded body velocity is prescribed as zero-wind airspeed; linearly interpolated collective; fixed RPM; no ground, disc tilt or free-flight integration.', cases }) + '\n');
  console.log(`Benchmarked ${samples.length} samples in ${cases.length} cases.`);
}
