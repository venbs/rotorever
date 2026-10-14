import test from 'node:test';
import assert from 'node:assert/strict';
import { axisAngle, conjugate, integrateAttitude, norm, rotate, vec } from '../src/physics/math.ts';
import { parameters } from '../src/physics/parameters.ts';
import { equilibriumInflow, hoverTrim, rotorLoads } from '../src/physics/rotor.ts';
import { defaultInput, FixedStepClock, HelicopterSimulation, type FlightInput } from '../src/physics/simulator.ts';

const dt = 1 / 250;
function hover() {
  const sim = new HelicopterSimulation(), input = defaultInput();
  input.collective = sim.hover(input.targetRPM); input.motor = true;
  return { sim, input };
}
function run(sim: HelicopterSimulation, input: FlightInput, seconds: number, step = dt) {
  for (let i = 0; i < Math.round(seconds / step); i++) sim.step(step, input);
}
const close = (actual: number, expected: number, tolerance: number, message = '') => assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} vs ${expected} (±${tolerance})`);

test('body/world transforms round-trip and quaternion stays unit length', () => {
  let q = axisAngle(vec(0, 1, 0), 1.4);
  for (let i = 0; i < 10000; i++) q = integrateAttitude(q, vec(1.2, -0.7, 0.4), dt);
  close(Math.hypot(q.x, q.y, q.z, q.w), 1, 1e-12);
  const result = rotate(conjugate(q), rotate(q, vec(1, 2, 3)));
  close(result.x, 1, 1e-12); close(result.y, 2, 1e-12); close(result.z, 3, 1e-12);
});

test('rotor produces no load at rest and symmetric thrust under pitch reversal', () => {
  assert.deepEqual(rotorLoads(0, 0, 0, vec()), { thrust: 0, torque: 0 });
  const positive = rotorLoads(220, 0.1, 3, vec());
  const negative = rotorLoads(220, -0.1, -3, vec());
  assert.ok(positive.thrust > 0 && positive.torque > 0);
  close(positive.thrust, -negative.thrust, 1e-10);
  close(positive.torque, negative.torque, 1e-10);
});

test('hover trim closes thrust and momentum-inflow equations across RPM range', () => {
  for (const rpm of [1800, 2100, 2600]) {
    const thrust = parameters.mass * parameters.gravity;
    const trim = hoverTrim(rpm * Math.PI / 30, thrust);
    close(trim.thrust, thrust, 1e-8);
    close(trim.inflow, equilibriumInflow(trim.thrust, vec()), 1e-8);
    assert.ok(trim.pitch > 0 && trim.pitch < parameters.rotor.maxPitch);
  }
});

test('force-balanced hover stays stationary for 30 seconds without position/altitude hold', () => {
  for (const assist of [true, false]) {
    const { sim, input } = hover(); input.assist = assist;
    run(sim, input, 30);
    close(sim.state.position.y, 1.5, 1e-7);
    close(norm(sim.state.velocity), 0, 1e-7);
    close(sim.state.rotorSpeed * 30 / Math.PI, 2100, 1e-7);
    assert.equal(sim.state.crashed, false);
  }
});

test('collective step increases climb and temporarily loads the rotor/governor', () => {
  const { sim, input } = hover();
  input.collective += 0.15;
  let minimumRPM = 2100;
  for (let i = 0; i < 250; i++) { sim.step(dt, input); minimumRPM = Math.min(minimumRPM, sim.state.rotorSpeed * 30 / Math.PI); }
  assert.ok(sim.state.velocity.y > 1 && sim.state.position.y > 2);
  // Load precompensation removes the old PI-only sag, but the finite motor
  // still loses some RPM while electrical torque catches up.
  assert.ok(minimumRPM < 2099 && minimumRPM > 2050, `unexpected headspeed ${minimumRPM}`);
  run(sim, input, 5);
  close(sim.state.rotorSpeed * 30 / Math.PI, 2100, 5);
  assert.equal(sim.state.crashed, false);
});

test('negative collective supports an inverted hover in rate mode', () => {
  const { sim, input } = hover();
  const bank = 2 * Math.asin(sim.state.attitude.x);
  sim.state.attitude = axisAngle(vec(1, 0, 0), Math.PI - bank);
  sim.state.collective *= -1; sim.state.inflow *= -1;
  input.collective *= -1; input.assist = false;
  run(sim, input, 10);
  close(sim.state.position.y, 1.5, 1e-7);
  close(norm(sim.state.velocity), 0, 1e-7);
  assert.ok(sim.state.thrust < 0);
  assert.equal(sim.state.crashed, false);
});

test('motor shutdown leaves rotor inertia and reduces speed', () => {
  const { sim, input } = hover(); input.motor = false;
  run(sim, input, 0.5);
  assert.ok(sim.state.rotorSpeed > 100 && sim.state.rotorSpeed < 2100 * Math.PI / 30);
  assert.ok(sim.state.motorTorque < 0.01);
});

test('roll, pitch, yaw commands produce the documented body-axis signs', () => {
  for (const [channel, axis, sign] of [['roll', 'x', 1], ['pitch', 'z', -1], ['yaw', 'y', -1]] as const) {
    const { sim, input } = hover(); input.assist = false; input[channel] = 0.4;
    run(sim, input, 0.5);
    assert.ok(sim.state.rates[axis] * sign > 0.5, `${channel} response has wrong sign`);
    assert.ok(Math.hypot(sim.state.attitude.x, sim.state.attitude.y, sim.state.attitude.z, sim.state.attitude.w) > 0.999);
    assert.equal(sim.state.crashed, false);
  }
});

test('skids support gravity and the helicopter can spool up then take off', () => {
  const sim = new HelicopterSimulation(), input = defaultInput();
  run(sim, input, 5);
  close(sim.state.position.y, parameters.skidHeight - parameters.mass * parameters.gravity / (4 * 2200), 1e-5);
  assert.equal(sim.state.grounded, true);
  input.motor = true; run(sim, input, 6);
  close(sim.state.rotorSpeed * 30 / Math.PI, 2100, 10);
  assert.equal(sim.state.crashed, false);
  input.collective = 0.4; run(sim, input, 1);
  assert.ok(sim.state.position.y > 0.5);
  assert.equal(sim.state.grounded, false);
});

test('a hard landing stops flight and reset clears dynamic/controller state', () => {
  const { sim, input } = hover(); sim.state.position.y = 0.16; sim.state.velocity.y = -5;
  run(sim, input, 0.1);
  assert.equal(sim.state.crashed, true);
  sim.reset();
  assert.equal(sim.state.crashed, false); assert.equal(sim.state.rotorSpeed, 0);
  assert.equal(norm(sim.state.velocity), 0);
});

test('physics results agree at 30/60/144 rendering FPS with the same input timeline', () => {
  const results = [30, 60, 144].map(fps => {
    const { sim, input } = hover(); const clock = new FixedStepClock();
    input.assist = true; // The old test's mild attitude-assisted maneuver; 3D is now the default.
    for (let i = 0; i < fps * 4; i++) clock.advance(1 / fps, step => {
      input.roll = sim.state.time < 1 ? 0.15 : 0;
      sim.step(step, input);
    });
    return sim.state;
  });
  for (const s of results) {
    close(s.time, 4, 1e-9);
    close(s.position.z, results[0].position.z, 1e-9);
    close(s.position.y, results[0].position.y, 1e-9);
  }
});

test('halving the integration step produces a converging mild maneuver', () => {
  const a = hover(), b = hover(); a.input.roll = 0.12; b.input.roll = 0.12;
  run(a.sim, a.input, 1, 1 / 250); run(b.sim, b.input, 1, 1 / 500);
  close(a.sim.state.position.z, b.sim.state.position.z, 0.005);
  close(a.sim.state.position.y, b.sim.state.position.y, 0.005);
});

test('long frame stalls are bounded and invalid physics dt is rejected', () => {
  const clock = new FixedStepClock(); let steps = 0;
  clock.advance(3, () => steps++);
  assert.equal(steps, 25); close(clock.droppedTime, 2.9, 1e-10);
  assert.throws(() => new HelicopterSimulation().step(1, defaultInput()));
});
