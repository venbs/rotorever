import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultFbl, readFbl, validFbl, fblAxes } from '../src/physics/fbl.ts';
import { HelicopterSimulation, defaultInput } from '../src/physics/simulator.ts';
import { measureResponse } from '../scripts/response-metrics.ts';
import { deg } from '../src/physics/math.ts';

test('small stick changes, reversals and stops stay crisp without bounce across RPM and collective', () => {
  for (const axis of fblAxes) for (const stick of [-0.25, 0.25]) for (const rpm of [1800, 2100, 2600]) for (const collective of [-0.27, 0, 0.27]) {
    const result = measureResponse(axis, stick, collective, rpm);
    const context = JSON.stringify(result);
    assert.equal(result.crashed, false, context);
    assert.ok(result.rise.t90 <= 40 && result.reverse.t90 <= 60, context);
    for (const segment of [result.rise, result.reverse, result.stop]) {
      assert.ok(segment.settlingMs <= 100, context);
      assert.ok(segment.overshootPct < 6, context);
      assert.ok(segment.finalError < 1, context);
    }
  }
});

test('full rate response is faster while preserving rates and a clean stop', () => {
  for (const axis of fblAxes) for (const stick of [-1, 1]) for (const collective of [-0.27, 0, 0.27]) {
    const result = measureResponse(axis, stick, collective), context = JSON.stringify(result);
    assert.equal(result.crashed, false, context);
    assert.ok(result.rise.t90 <= (axis === 'roll' ? 36 : axis === 'pitch' ? 60 : 92), context);
    assert.ok(result.reverse.t90 <= (axis === 'yaw' ? 190 : 115), context);
    for (const segment of [result.rise, result.reverse, result.stop]) assert.ok(segment.overshootPct < 6, context);
    assert.ok(result.stop.settlingMs <= 100, context);
  }
});

test('PID, steady FF and Boost independently affect the physical response', () => {
  const tuned = measureResponse('roll', 0.25);
  const noBoost = defaultFbl(); noBoost.roll.b = 0;
  assert.ok(measureResponse('roll', 0.25, 0.27, 2100, noBoost).rise.t90 > tuned.rise.t90);
  const noD = defaultFbl(); noD.roll.d = 0;
  assert.ok(measureResponse('roll', 0.25, 0.27, 2100, noD).rise.overshootPct > tuned.rise.overshootPct + 5);
  const lowP = defaultFbl(); lowP.roll.p = 20; lowP.roll.b = 0;
  assert.ok(measureResponse('roll', 0.25, 0.27, 2100, lowP).rise.t90 > 2 * tuned.rise.t90);
  // With no rate feedback, FF alone balances modeled damping but cannot step the
  // body's inertia instantly. Removing it must remove the sustained drive.
  const noFeedback = defaultFbl(); Object.assign(noFeedback.roll, { p: 0, i: 0, d: 0, b: 0, ff: 100 });
  const ff = measureResponse('roll', 0.25, 0.27, 2100, noFeedback);
  noFeedback.roll.ff = 0;
  assert.ok(ff.rise.finalError < measureResponse('roll', 0.25, 0.27, 2100, noFeedback).rise.finalError - 10);
  const sim = new HelicopterSimulation(), input = defaultInput();
  input.collective = sim.hover(); sim.state.position.y = 100; input.motor = true;
  input.roll = 0.25; input.fbl.roll.ff = 0;
  for (let n = 0; n < 250; n++) sim.step(0.004, input);
  assert.ok(sim.state.pid.roll.i > 0, 'I must supply the missing steady torque');
  input.fbl.roll.i = 0;
  sim.step(0.004, input);
  assert.equal(sim.state.pid.roll.i, 0);
  sim.resetController();
  input.roll = 0;
  for (let n = 0; n < 100; n++) sim.step(0.004, input);
  assert.ok(Math.abs(deg(sim.state.rates.x)) < 1);
});

test('FBL profiles round-trip; corrupt or out-of-range settings fall back atomically', () => {
  const profile = defaultFbl(); profile.pitch.p = 76; profile.yaw.ff = 90; profile.bCutoff = 28;
  assert.deepEqual(readFbl(JSON.stringify(profile)), profile);
  for (const invalid of [null, {}, { ...profile, roll: null }, { ...profile, dCutoff: 0 }, { ...profile, yaw: { ...profile.yaw, d: -1 } }]) {
    assert.equal(validFbl(invalid), false);
    assert.deepEqual(readFbl(JSON.stringify(invalid)), defaultFbl());
  }
  assert.deepEqual(readFbl('{broken'), defaultFbl());
  const a = defaultInput(), b = defaultInput(); a.fbl.roll.p = 0;
  assert.equal(b.fbl.roll.p, 85, 'profiles must not share mutable gain objects');
});
