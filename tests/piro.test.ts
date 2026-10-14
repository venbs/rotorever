import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultFbl, rotateCyclicError, rateIntegralLimit } from '../src/physics/fbl.ts';
import { add, axisAngle, identity, integrateAttitude, norm, rad, rotate, scale, vec } from '../src/physics/math.ts';
import { defaultInput, HelicopterSimulation } from '../src/physics/simulator.ts';

const closeVector = (a: ReturnType<typeof vec>, b: ReturnType<typeof vec>, tolerance = 1e-10) =>
  assert.ok(norm(add(a, scale(b, -1))) < tolerance, `${JSON.stringify(a)} != ${JSON.stringify(b)}`);

test('RF-reference compensation preserves the spatial error through either piro direction and reversals', () => {
  for (const sign of [-1, 1]) {
    const original = vec(.13, -.21, .18), profile = defaultFbl();
    let error = { ...original }, attitude = identity();
    for (let k = 0; k < 3000; k++) {
      const dt = k % 2 ? .002 : .001, yaw = sign * rad(k < 1500 ? 650 : -1200);
      attitude = integrateAttitude(attitude, vec(0, yaw, 0), dt);
      error = rotateCyclicError(error, yaw * dt, profile);
      closeVector(rotate(attitude, error), original);
      assert.ok(Math.abs(norm(error) - norm(original)) < 1e-10, 'rotation must not charge the integral');
      assert.equal(error.y, original.y, 'piro compensation must leave yaw memory alone');
    }
  }
});

test('switch and percentage provide zero, partial and full compensation with bounded stored error', () => {
  const error = vec(.2, -.1, 0), profile = defaultFbl();
  closeVector(rotateCyclicError(error, Math.PI / 2, profile), vec(0, -.1, .2));
  for (const gain of [0, 50, 100, 150]) {
    const result = rotateCyclicError(error, Math.PI / 2, { ...profile, errorRotationGain: gain });
    // Compare to the independent quaternion attitude transform.
    closeVector(rotate(axisAngle(vec(0, 1, 0), Math.PI / 2 * gain / 100), result), error);
  }
  closeVector(rotateCyclicError(error, Math.PI / 2, { ...profile, errorRotation: false }), error);
  closeVector(rotateCyclicError(error, 0, profile), error);
  const limited = rotateCyclicError(vec(rateIntegralLimit, .1, rateIntegralLimit), Math.PI / 4, profile);
  assert.ok(Math.abs(limited.x) <= rateIntegralLimit && Math.abs(limited.z) <= rateIntegralLimit);
});

test('the running FBL transports measured-yaw error before I gain and keeps the legacy path available', () => {
  for (const sign of [-1, 1]) for (const gain of [0, 50, 100, 150]) for (const enabled of [false, true]) {
    const sim = new HelicopterSimulation(), input = defaultInput(), dt = .002;
    input.collective = sim.hover(); sim.state.position.y = 100; input.motor = true;
    input.fbl.errorRotation = enabled; input.fbl.errorRotationGain = gain;
    // An external rate impulse lets the real feedback loop build nonzero I memory.
    sim.state.rates = vec(rad(40), 0, rad(20));
    for (let k = 0; k < 50; k++) sim.step(dt, input);
    const stored = () => vec(sim.state.pid.roll.i / (sim.params.inertia.x * input.fbl.roll.i), 0,
      sim.state.pid.pitch.i / (sim.params.inertia.z * input.fbl.pitch.i));
    const before = stored();
    assert.ok(norm(before) > 1e-4, 'test must exercise stored error, not only a zero integral');
    const yaw = sign * rad(650);
    sim.state.rates = vec(0, yaw, 0);
    // Neutral yaw stick deliberately disagrees with the measured rate.
    assert.equal(input.yaw, 0);
    sim.step(dt, input);
    const effectiveAngle = enabled ? yaw * dt * gain / 100 : 0;
    closeVector(rotate(axisAngle(vec(0, 1, 0), effectiveAngle), stored()), before);
    assert.equal(sim.state.crashed, false);
  }
});
