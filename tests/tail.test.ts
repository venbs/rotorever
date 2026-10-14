import test from 'node:test';
import assert from 'node:assert/strict';
import { HelicopterSimulation, defaultInput } from '../src/physics/simulator.ts';
import { applyAircraft } from '../src/aircraft-settings.ts';
import { benchmarkAircraft } from '../scripts/benchmark-aircraft.ts';
import { parameters } from '../src/physics/parameters.ts';
import { deg } from '../src/physics/math.ts';
import { tailRotorSpeed, tailShaftTorque, tailThrustLimit } from '../src/physics/tail.ts';
import { tailExperiment } from '../scripts/tail-response-benchmark.ts';

const close = (actual: number, expected: number, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
function airborne(motor = 90) {
  const sim = new HelicopterSimulation(), input = defaultInput(), profile = benchmarkAircraft();
  profile.motorTorque = motor; profile.aerodynamics = { liftGain: 120, axialDamping: 130, bodyDrag: 100 };
  applyAircraft(sim, input, profile); input.motor = true; input.collective = sim.hover(profile.rpm); sim.state.position.y = 1000;
  return { sim, input };
}

test('tail authority follows mechanical gearing and RPM squared, including coast-down', () => {
  const p = structuredClone(parameters), omega = 2100 * Math.PI / 30;
  const force = tailThrustLimit(omega, p);
  close(tailRotorSpeed(omega, p), omega * 80 / 19);
  close(tailThrustLimit(omega * .5, p), force * .25);
  p.tailRatio *= 1.2;
  close(tailThrustLimit(omega, p), force * 1.2 ** 2);
  p.density *= .5;
  close(tailThrustLimit(omega, p), force * 1.2 ** 2 * .5);
  close(tailThrustLimit(0, p), 0); close(tailRotorSpeed(0, p), 0);
  const { sim, input } = airborne(); input.motor = false;
  const phase = sim.state.tailPhase;
  sim.step(.002, input);
  assert.ok(sim.state.rotorSpeed > 0 && tailThrustLimit(sim.state.rotorSpeed, sim.params) > 0);
  const delta = (sim.state.tailPhase - phase + 2 * Math.PI) % (2 * Math.PI);
  close(delta, (tailRotorSpeed(sim.state.rotorSpeed, sim.params) * .002) % (2 * Math.PI));
});

test('motor power and yaw reaction close separate shaft balances through reversals and RPM changes', () => {
  for (const motor of [90, 100]) {
    const { sim, input } = airborne(motor), dt = .002;
    for (let k = 0; k < 1200; k++) {
      input.collective = Math.floor(k / 80) % 2 ? -1 : 1;
      input.yaw = Math.sin(k * dt * 4);
      input.targetRPM = k < 400 ? 2400 : k < 800 ? 2600 : 2100;
      const previousSpeed = sim.state.rotorSpeed;
      sim.step(dt, input);
      const s = sim.state, p = sim.params;
      const acceleratingTorque = p.rotor.inertia * (s.rotorSpeed - previousSpeed) / dt;
      const tailLoad = tailShaftTorque(s.tailForce, previousSpeed, p);
      close(s.mainRotorTorque, s.aerodynamicTorque + acceleratingTorque, 1e-8);
      close(s.motorTorque, s.mainRotorTorque + tailLoad + p.motor.friction, 1e-8);
      assert.ok(Math.abs(s.tailForce) <= tailThrustLimit(previousSpeed, p) + 1e-9, 'tail exceeded its instantaneous authority');
      assert.equal(s.crashed, false);
    }
  }
});

test('hard collective pumps hold yaw across short and sustained strokes at finite and ideal motor settings', () => {
  for (const motor of [90, 100]) for (const pumpPeriod of [.08, .16, .32, .64]) {
    const r = tailExperiment({ motor, pumpPeriod });
    assert.equal(r.crashed, false);
    assert.ok(r.maxYaw < 2, `uncommanded yaw during pumps: ${motor}%/${pumpPeriod}s = ${r.maxYaw}`);
    assert.ok(r.maxHeading < .5, `heading escaped: ${r.maxHeading}`);
    if (motor === 100) close(r.minRPM, 2400);
    // Long ±12° reversals now include high-incidence separation and drag. The
    // old >2000 RPM floor excluded that intentional load (~1980 RPM here).
    // Keep the finite-power/recovery envelope; heading limits stay unchanged.
    else assert.ok(r.minRPM < 2399 && r.minRPM > 1800, 'finite drive must sag without collapsing');
  }
});

test('both piro directions and mixed cyclic retain yaw tracking and stop authority under collective load', () => {
  for (const motor of [90, 100]) for (const pumpPeriod of [.16, .32, .64]) for (const scenario of ['piro-left', 'piro-right', 'mixed'] as const) {
    const r = tailExperiment({ motor, pumpPeriod, scenario });
    const context = `${motor}%/${pumpPeriod}s/${scenario}`;
    assert.equal(r.crashed, false, context);
    // Measure after 200 ms of each commanded start/stop, never score the intended piro as blowout.
    assert.ok(r.peakSteadyError < 5, `${context}: tracking error ${r.peakSteadyError} deg/s`);
    assert.ok(r.peakNeutralRate < 5, `${context}: uncommanded rate ${r.peakNeutralRate} deg/s`);
    assert.ok(r.maxYaw < 650 * 1.08, `${context}: excessive overshoot ${r.maxYaw}`);
  }
});

test('a genuinely undersized tail can still saturate and lose yaw; no hidden heading lock', () => {
  const { sim, input } = airborne(100);
  sim.params.tailMaxForce = 1;
  input.collective = sim.hover(2400); sim.state.position.y = 1000;
  assert.ok(Math.abs(sim.state.tailForce) <= tailThrustLimit(sim.state.rotorSpeed, sim.params));
  input.collective = .9;
  let saturated = false, peak = 0;
  for (let k = 0; k < 250; k++) {
    const omega = sim.state.rotorSpeed;
    sim.step(.002, input);
    saturated ||= sim.state.pid.yaw.saturated;
    peak = Math.max(peak, Math.abs(deg(sim.state.rates.y)));
    assert.ok(Math.abs(sim.state.tailForce) <= tailThrustLimit(omega, sim.params) + 1e-9);
  }
  assert.ok(saturated && peak > 100, `weak tail was invisibly stabilized: ${peak}`);
});

test('aggressive yaw/load response converges with a smaller internal step', () => {
  for (const motor of [90, 100]) {
    const a = tailExperiment({ motor, scenario: 'mixed', duration: 4, dt: .002 });
    const b = tailExperiment({ motor, scenario: 'mixed', duration: 4, dt: .001 });
    assert.ok(Math.abs(a.minRPM - b.minRPM) < 10);
    assert.ok(Math.abs(a.maxYaw - b.maxYaw) < 5);
    assert.ok(b.peakNeutralRate < 5 && b.peakSteadyError < 5);
  }
});
