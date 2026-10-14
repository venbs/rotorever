import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAircraft } from '../src/aircraft-settings.ts';
import { benchmarkAircraft } from '../scripts/benchmark-aircraft.ts';
import { defaultInput, HelicopterSimulation } from '../src/physics/simulator.ts';
import { collectiveExperiment } from '../scripts/flight-feel-benchmark.ts';

const dt = 1 / 250;
const rpm = (sim: HelicopterSimulation) => sim.state.rotorSpeed * 30 / Math.PI;
function setup(motorTorque: number, targetRPM = 2100, pitch = 13) {
  const sim = new HelicopterSimulation(), input = defaultInput();
  const profile = { ...benchmarkAircraft(), motorTorque, rpm: targetRPM, pitch };
  applyAircraft(sim, input, profile);
  input.collective = sim.hover(targetRPM); input.motor = true; sim.state.position.y = 100;
  return { sim, input, profile };
}

test('maximum torque holds exact RPM through full collective reversals and tail loading', () => {
  for (const target of [1200, 2100, 3000]) for (const pitch of [13, 18]) {
    const { sim, input } = setup(100, target, pitch);
    for (let i = 0; i < 500; i++) {
      input.collective = Math.floor(i / 25) % 2 ? -1 : 1;
      input.yaw = Math.floor(i / 50) % 2 ? -1 : 1;
      const omega = sim.state.rotorSpeed;
      sim.step(dt, input);
      assert.equal(sim.state.crashed, false, `crashed at ${target} RPM / ${pitch} degrees`);
      assert.ok(Math.abs(rpm(sim) - target) < 1e-8, `RPM changed under load: ${rpm(sim)}`);
      // The ideal drive must actually supply the shaft load, not merely repaint the RPM HUD.
      const force = Math.abs(sim.state.tailForce), p = sim.params;
      const tailPower = force ** 1.5 / Math.sqrt(2 * p.density * Math.PI * 0.105 ** 2) / 0.72 + 16 * (omega / (2100 * Math.PI / 30)) ** 3;
      const load = sim.state.aerodynamicTorque + tailPower / Math.max(omega, 20) + p.motor.friction;
      assert.ok(Math.abs(sim.state.motorTorque - load) < 1e-8, 'shaft torque does not balance the load');
    }
  }
});

test('finite torque settings retain droop, with stronger settings reducing it', () => {
  const lows = [50, 75, 99, 100].map(setting => {
    const { sim, input } = setup(setting); input.collective = 1;
    let minimum = rpm(sim);
    for (let i = 0; i < 250; i++) { sim.step(dt, input); minimum = Math.min(minimum, rpm(sim)); }
    assert.equal(sim.state.crashed, false);
    return minimum;
  });
  // Force calibration changes shaft loading; assert finite-drive behavior,
  // not the old rotor model's particular minimum RPM.
  assert.ok(lows[0] < 2100 * .95 && lows[0] > 2100 * .7, `finite drive droop/collapse: ${lows}`);
  for (let i = 1; i < lows.length; i++) assert.ok(lows[i] > lows[i - 1], `strength is not increasing: ${lows}`);
  assert.ok(lows[2] < 2099, 'finite torque must not silently enable ideal mode');
});

test('ideal governor ramps startup, follows target changes, and releases on motor shutdown', () => {
  const { sim, input } = setup(100); sim.reset(); input.collective = 0;
  sim.step(dt, input);
  assert.ok(rpm(sim) > 0 && rpm(sim) < 10, 'startup must not jump straight to governed RPM');
  // Cold start now includes a gentle low-RPM ramp before the normal ramp rate.
  for (let i = 0; i < 1250; i++) sim.step(dt, input);
  assert.ok(Math.abs(rpm(sim) - 2100) < 1e-8);
  input.targetRPM = 2600;
  for (let i = 0; i < 150; i++) sim.step(dt, input);
  assert.ok(Math.abs(rpm(sim) - 2600) < 1e-8);
  input.targetRPM = 1800;
  for (let i = 0; i < 175; i++) sim.step(dt, input);
  assert.ok(Math.abs(rpm(sim) - 1800) < 1e-8);
  input.motor = false; sim.step(dt, input);
  assert.ok(rpm(sim) > 1700, 'rotor inertia must remain after disarming');
  for (let i = 0; i < 125; i++) sim.step(dt, input);
  assert.ok(rpm(sim) > 0 && rpm(sim) < 1790);
  assert.ok(Math.abs(sim.state.motorTorque) < 0.01);
  assert.equal(sim.state.crashed, false);
});

test('enabling maximum torque during droop recovers smoothly; turning it down restores finite drive', () => {
  const { sim, input, profile } = setup(50); input.collective = 1;
  for (let i = 0; i < 100; i++) sim.step(dt, input);
  assert.ok(rpm(sim) < 1900);
  const before = rpm(sim);
  // Change only motor strength; application defaults may use a different RPM.
  applyAircraft(sim, input, { ...profile, motorTorque: 100 });
  sim.step(dt, input);
  assert.ok(rpm(sim) > before && rpm(sim) < before + 6, 'switching must not create a torque impulse');
  for (let i = 0; i < 150; i++) sim.step(dt, input);
  assert.ok(Math.abs(rpm(sim) - 2100) < 1e-8);
  applyAircraft(sim, input, { ...profile, motorTorque: 10 });
  for (let i = 0; i < 150; i++) sim.step(dt, input);
  assert.ok(rpm(sim) < 2050);
  assert.equal(sim.state.crashed, false);
});

test('collective load precompensation improves response without changing blade pitch timing', () => {
  for (const increment of [1, 4, 10]) {
    const before = collectiveExperiment(true, increment), after = collectiveExperiment(false, increment);
    assert.equal(after.pitch99Ms, before.pitch99Ms, 'improvement must not be an artificial pitch or thrust impulse');
    assert.ok(after.pitch99Ms <= 12, `slow collective actuator: ${after.pitch99Ms} ms`);
    assert.ok(2400 - after.minimumRPM < (2400 - before.minimumRPM) * .4, 'load precomp failed to reduce sag');
    assert.ok(after.at500ms.velocity > before.at500ms.velocity);
  }
  const step = collectiveExperiment(false, 10);
  assert.ok(step.minimumRPM > 2250 && step.minimumRPM < 2399, 'finite motor still needs real power headroom');
  assert.ok(step.at100ms.acceleration > 44 && step.at100ms.acceleration < 50);
});

test('ideal governor and calibrated rotor forces are unchanged by load precompensation', () => {
  const before = collectiveExperiment(true, 4, 100), after = collectiveExperiment(false, 4, 100);
  assert.deepEqual(after.traces, before.traces, '100% motor response should remain identical');
});

test('finite motor remains bounded through sustained collective reversals, rearming and target changes', () => {
  for (const setting of [10, 50, 90, 99]) {
    const { sim, input } = setup(setting, 2400, 12); sim.state.position.y = 1000;
    let peakRPM = 0;
    for (let i = 0; i < 2000; i++) {
      input.collective = Math.floor(i / 40) % 2 ? -.8 : .8;
      input.yaw = .4 * Math.sin(i / 60);
      input.motor = !(i >= 1000 && i < 1150);
      input.targetRPM = i < 1500 ? 2400 : 2100;
      sim.step(dt, input);
      const omega = sim.state.rotorSpeed;
      peakRPM = Math.max(peakRPM, rpm(sim));
      assert.ok(Number.isFinite(omega) && omega >= 0);
      assert.ok(sim.state.motorTorque >= 0 && sim.state.motorTorque <= sim.params.motor.maxTorque * setting / 50 + 1e-8);
      // Integration changes RPM slightly after torque limiting; allow that one substep.
      assert.ok(sim.state.motorTorque * omega <= sim.params.motor.maxPower * setting / 50 * 1.01);
      assert.equal(sim.state.crashed, false);
      if (i === 1149) assert.ok(sim.state.motorTorque < .01, 'precomp must not keep the motor running while disarmed');
    }
    assert.ok(peakRPM < 2400 * 1.10, `uncontrolled governor overspeed at ${setting}%: ${peakRPM}`);
  }
});

test('collective response converges at smaller physics steps', () => {
  const coarse = collectiveExperiment(false, 10, 90, .004), fine = collectiveExperiment(false, 10, 90, .001);
  assert.ok(Math.abs(coarse.minimumRPM - fine.minimumRPM) < 3);
  assert.ok(Math.abs(coarse.at100ms.acceleration - fine.at100ms.acceleration) < .3);
  assert.ok(Math.abs(coarse.at500ms.velocity - fine.at500ms.velocity) < .05);
});
