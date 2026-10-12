import test from 'node:test';
import assert from 'node:assert/strict';
import { collectiveStep, braking } from '../scripts/collective-benchmark.ts';

const ideal = { name: 'test-ideal', mass: 3.8, rpm: 2400, motor: 100 };

test('collective benchmark distinguishes actuator arrival from changing flight acceleration', () => {
  const full = collectiveStep(ideal, 'full');
  assert.ok(full.pitch99Ms !== null && full.pitch99Ms <= 16);
  assert.ok(full.traces.every(t => Math.abs(t.rpm - 2400) < 1e-6));
  assert.ok(full.at500ms.velocity > full.at100ms.velocity);
  assert.ok(full.at500ms.acceleration < full.at100ms.acceleration);
  const fine = collectiveStep({ ...ideal, dt: .001 }, 'full');
  assert.ok(Math.abs(full.at500ms.velocity - fine.at500ms.velocity) < .1);
  assert.ok(Math.abs(full.at100ms.acceleration - fine.at100ms.acceleration) < .2);
});

test('active reverse collective brakes ascent sooner than zero or hover pitch', () => {
  const reverse = braking(ideal, 'negative-half'), zero = braking(ideal, 'zero'), hover = braking(ideal, 'hover');
  assert.ok(reverse.initialVelocity > 4);
  assert.ok(reverse.zeroCrossMs !== null && zero.zeroCrossMs !== null);
  assert.ok(reverse.zeroCrossMs < zero.zeroCrossMs);
  assert.equal(hover.zeroCrossMs, null);
});
