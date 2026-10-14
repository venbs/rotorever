import test from 'node:test';
import assert from 'node:assert/strict';
import { HelicopterSimulation, defaultInput } from '../src/physics/simulator.ts';
import { defaultRates, expoCurve, rateCommand } from '../src/physics/rates.ts';
import { deg, rotate, vec } from '../src/physics/math.ts';
import { GroundCamera, pilotEye } from '../src/scene/camera.ts';
import { Vector3 } from 'three';
import { parameters } from '../src/physics/parameters.ts';

const dt = 0.004;
function airborne(height = 100) {
  const sim = new HelicopterSimulation(), input = defaultInput();
  input.collective = sim.hover(); input.motor = true; sim.state.position.y = height;
  return { sim, input };
}

test('3D is the default; cubic Expo preserves 350/620 full rates and softens center response', () => {
  assert.equal(defaultInput().assist, false);
  assert.deepEqual(defaultRates(), { cyclic: 350, yaw: 620, expo: 0.4 });
  for (const expo of [0, 0.4, 0.8]) for (const rate of [350, 620]) {
    assert.ok(Math.abs(deg(rateCommand(1, rate, expo)) - rate) < 1e-9);
    assert.ok(Math.abs(deg(rateCommand(-1, rate, expo)) + rate) < 1e-9);
    assert.equal(rateCommand(0, rate, expo), 0);
  }
  assert.ok(Math.abs(deg(rateCommand(0.5, 350, 0.4)) - 122.5) < 1e-9);
  assert.ok(Math.abs(expoCurve(0.5, 0.4) - 0.35) < 1e-9);
  assert.ok(Math.abs(expoCurve(-0.5, 0.4) + 0.35) < 1e-9);
});

test('both directions reach commanded rates at positive, zero and negative collective, then brake', () => {
  for (const [channel, axis, sign, target] of [['roll', 'x', 1, 350], ['pitch', 'z', -1, 350], ['yaw', 'y', -1, 620]] as const) {
    for (const direction of [-1, 1]) for (const collective of [-0.27, 0, 0.27]) {
      const { sim, input } = airborne(); input[channel] = direction; input.collective = collective;
      let t90 = Infinity, peak = 0;
      for (let step = 1; step <= 250; step++) {
        sim.step(dt, input);
        const actual = deg(sim.state.rates[axis]) * sign * direction;
        peak = Math.max(peak, actual);
        if (actual >= target * 0.9) t90 = Math.min(t90, step * dt);
      }
      const context = `${channel}, direction ${direction}, collective ${collective}`;
      assert.ok(t90 <= (channel === 'yaw' ? 0.2 : 0.12), `${context}: t90=${t90}`);
      assert.ok(peak < target * 1.08, `${context}: excessive overshoot ${peak}`);
      assert.ok(Math.abs(deg(sim.state.rates[axis]) * sign * direction - target) < target * 0.03, `${context}: steady rate`);
      input[channel] = 0;
      for (let step = 0; step < 45; step++) sim.step(dt, input);
      assert.ok(Math.abs(deg(sim.state.rates[axis])) < 10, `${context}: failed to brake in 180 ms`);
      assert.equal(sim.state.crashed, false);
    }
  }
});

test('normal pilot inputs complete 360° rolls and flips from 6 m, crossing inverted under negative collective', () => {
  for (const [channel, axis, sign] of [['roll', 'x', 1], ['pitch', 'z', -1]] as const) for (const direction of [-1, 1]) {
    const { sim, input } = airborne(6), trim = input.collective;
    let rotation = 0, sawInverted = false, minHeight = 6, fullCircleTime = 0;
    // Scripted pilot stick/collective sequence only. No attitude/rate assignments,
    // hidden altitude hold, forced angular velocity or teleport through inverted.
    while (sim.state.time < 1.6 && rotation < 352) {
      input[channel] = direction;
      const up = rotate(sim.state.attitude, vec(0, 1, 0));
      input.collective = trim * up.y;
      sim.step(dt, input);
      rotation += deg(sim.state.rates[axis]) * sign * direction * dt;
      minHeight = Math.min(minHeight, sim.state.position.y);
      if (up.y < -0.95 && input.collective < 0) sawInverted = true;
    }
    fullCircleTime = sim.state.time;
    input[channel] = 0; input.collective = trim;
    for (let i = 0; i < 75; i++) {
      sim.step(dt, input);
      rotation += deg(sim.state.rates[axis]) * sign * direction * dt;
    }
    assert.ok(sawInverted, `${channel} never crossed inverted`);
    assert.ok(fullCircleTime < 1.2, `${channel} took ${fullCircleTime}s`);
    assert.ok(rotation > 355 && rotation < 370, `${channel}: ${rotation} degrees`);
    assert.ok(rotate(sim.state.attitude, vec(0, 1, 0)).y > 0.97, `${channel} did not end upright`);
    assert.ok(minHeight > 1, `${channel} fell too far: ${minHeight}`);
    assert.equal(sim.state.crashed, false, `${channel} crashed`);
  }
});

test('zero rotor RPM in still air has no cyclic/yaw authority', () => {
  const p = structuredClone(parameters); p.gravity = 0; // No falling airflow that could windmill the rotor.
  const sim = new HelicopterSimulation(p), input = defaultInput(); sim.state.position.y = 100;
  input.roll = 1; input.pitch = -1; input.yaw = 1; input.collective = 1;
  for (let i = 0; i < 250; i++) sim.step(dt, input);
  assert.deepEqual(sim.state.rates, vec());
  assert.equal(sim.state.rotorSpeed, 0);
});

test('coupled high-rate maneuver converges when the physics step is halved', () => {
  const states = [0.004, 0.002].map(step => {
    const { sim, input } = airborne();
    for (let k = 0; k < Math.round(1 / step); k++) {
      input.roll = k * step < 0.4 ? 0.6 : 0;
      input.pitch = k * step < 0.4 ? 1 : 0;
      input.yaw = k * step < 0.4 ? 0.8 : 0;
      input.collective = -0.2;
      sim.step(step, input);
    }
    assert.equal(sim.state.crashed, false);
    return sim.state;
  });
  const [a, b] = states;
  const alignment = Math.min(1, Math.abs(a.attitude.x * b.attitude.x + a.attitude.y * b.attitude.y + a.attitude.z * b.attitude.z + a.attitude.w * b.attitude.w));
  assert.ok(deg(2 * Math.acos(alignment)) < 2, 'attitude changes by more than 2° when halving dt');
  assert.ok(Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y, a.position.z - b.position.z) < 0.08);
  for (const axis of ['x', 'y', 'z'] as const) assert.ok(Math.abs(deg(a.rates[axis] - b.rates[axis])) < 2);
});

test('ground camera maintains its eye position and world horizon through flight, zoom and reset', () => {
  const rig = new GroundCamera();
  for (const target of [vec(0, 0.2, 0), vec(20, 8, -10), vec(-15, 20, 4), vec(100, 50, 0)]) {
    rig.track(target);
    assert.deepEqual(rig.camera.position.toArray(), [pilotEye.x, pilotEye.y, pilotEye.z]);
    rig.camera.updateMatrixWorld();
    const screen = new Vector3(target.x, target.y, target.z).project(rig.camera);
    assert.ok(Math.abs(screen.x) < 1e-10, 'horizontal bearing must follow immediately');
    assert.ok(Math.abs(screen.y) <= .350001, 'vertical lag must keep the aircraft in frame');
    assert.deepEqual(rig.camera.up.toArray(), [0, 1, 0]);
  }
  rig.zoom(-1000); assert.equal(rig.camera.fov, 20);
  rig.zoom(1000); assert.equal(rig.camera.fov, 65);
  rig.reset(); assert.equal(rig.camera.fov, 42);
  assert.deepEqual(rig.camera.position.toArray(), [pilotEye.x, pilotEye.y, pilotEye.z]);
});
