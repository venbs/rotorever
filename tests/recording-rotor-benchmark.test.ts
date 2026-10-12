import test from 'node:test';
import assert from 'node:assert/strict';
import { replayRotor } from '../scripts/recording-rotor-benchmark.ts';
import { parameters } from '../src/physics/parameters.ts';
import { hoverTrim } from '../src/physics/rotor.ts';

test('prescribed-airflow bench preserves a steady zero-airflow hover force', () => {
  const mass = parameters.mass, rpm = 2100;
  const trim = hoverTrim(rpm * Math.PI / 30, mass * parameters.gravity);
  const samples = [0, .027, .061, .089, .123, .15].map(t => ({
    t, collective: trim.pitch / parameters.rotor.maxPitch, bodyVelocity: [0, 0, 0],
  }));
  for (const dt of [.004, .002]) {
    const result = replayRotor(samples, mass, rpm, dt);
    assert.equal(result.acceleration.length, samples.length);
    for (const a of result.acceleration) assert.ok(Math.abs(a - parameters.gravity) < 1e-7);
  }
});

test('invalid timestamps and integration steps cannot silently produce a force curve', () => {
  const point = { t: 0, collective: 0, bodyVelocity: [0, 0, 0] };
  assert.throws(() => replayRotor([point, point], 3.2, 2100), /Invalid recording/);
  assert.throws(() => replayRotor([point, { ...point, t: .03 }], 3.2, 2100, 0), /Invalid benchmark/);
});
