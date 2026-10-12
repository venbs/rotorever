import test from 'node:test';
import assert from 'node:assert/strict';
import { parameters } from '../src/physics/parameters.ts';
import { equilibriumInflow, rotorLoads } from '../src/physics/rotor.ts';
import { defaultInput, HelicopterSimulation } from '../src/physics/simulator.ts';
import { vec, rad } from '../src/physics/math.ts';

function steady(pitch: number, axial: number, rpm = 2100) {
  let inflow = 0;
  const air = vec(0, axial, 0), omega = rpm * Math.PI / 30;
  for (let i = 0; i < 4000; i++) {
    const f = rotorLoads(omega, pitch, inflow, air);
    inflow += .02 * (equilibriumInflow(f.thrust, air) - inflow);
  }
  return rotorLoads(omega, pitch, inflow, air);
}

test('calibrated low-speed collective slope agrees with the recording across both pitch signs', () => {
  // Independent target: recording split fits span about 97–105 m/s² per unit
  // collective. Broader tolerance admits a physical curve, not a lookup table.
  for (const sign of [-1, 1]) {
    const deltaForce = steady(sign * rad(6.5), sign * 2).thrust - steady(sign * rad(3.25), sign * 2).thrust;
    const gain = deltaForce / (sign * .25) / parameters.mass;
    assert.ok(gain > 90 && gain < 115, `collective gain outside reference envelope: ${gain}`);
  }
});

test('mass does not secretly rescale aerodynamic force; RPM and density do', () => {
  const air = vec(1, 2, -1), p = structuredClone(parameters);
  const base = rotorLoads(220, .1, 3, air, p);
  p.mass *= 2;
  assert.deepEqual(rotorLoads(220, .1, 3, air, p), base);
  p.density *= .5;
  assert.ok(Math.abs(rotorLoads(220, .1, 3, air, p).thrust - .5 * base.thrust) < 1e-9);
  assert.ok(steady(rad(6), 0, 2400).thrust > steady(rad(6), 0, 1800).thrust * 1.5);
});

test('signed flow and collective reversal remain symmetric and continuous', () => {
  for (const omega of [0, 4.999, 5.001, 20, 39.999, 40.001, 220, 314]) {
    for (const pitch of [0, .1, rad(18)]) for (const axial of [-20, 0, 20]) {
      const a = rotorLoads(omega, pitch, 2, vec(3, axial, 1));
      const b = rotorLoads(omega, -pitch, -2, vec(3, -axial, 1));
      assert.ok(Number.isFinite(a.thrust + a.torque));
      assert.ok(Math.abs(a.thrust + b.thrust) < 1e-7);
      assert.ok(Math.abs(a.torque - b.torque) < 1e-7);
    }
  }
  const a = rotorLoads(39.999, .1, 1, vec(0, 3, 0)), b = rotorLoads(40.001, .1, 1, vec(0, 3, 0));
  assert.ok(Math.abs(a.thrust - b.thrust) < .01);
  assert.ok(Math.abs(a.torque - b.torque) < .01);
});

test('hard collective reversals stay finite over the user-facing mass/RPM range', () => {
  for (const mass of [1, 5, 8]) for (const rpm of [1200, 2400, 3000]) {
    const p = structuredClone(parameters); p.mass = mass; p.motor.torquePercent = 100; p.rotor.maxPitch = rad(18);
    for (const axis of ['x', 'y', 'z'] as const) p.inertia[axis] *= mass / parameters.mass;
    const sim = new HelicopterSimulation(p), input = defaultInput();
    input.collective = sim.hover(rpm); input.motor = true; input.targetRPM = rpm; sim.state.position.y = 1000;
    for (let k = 0; k < 1000; k++) {
      input.collective = Math.sin(k * .004 * 11);
      input.roll = .6 * Math.sin(k * .004 * 4); input.yaw = .5 * Math.sin(k * .004 * 3);
      sim.step(.004, input);
      assert.equal(sim.state.crashed, false, `numerical failure at ${mass} kg / ${rpm} RPM`);
      assert.ok(Number.isFinite(sim.state.position.y + sim.state.inflow + sim.state.motorTorque));
      assert.ok(Math.abs(sim.state.rotorSpeed * 30 / Math.PI - rpm) < 1e-7);
    }
  }
});
