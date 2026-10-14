import test from 'node:test';
import assert from 'node:assert/strict';
import { startupExperiment } from '../scripts/startup-benchmark.ts';
import { applyAircraft, defaultAircraft } from '../src/aircraft-settings.ts';
import { defaultInput, HelicopterSimulation } from '../src/physics/simulator.ts';
import { tailShaftTorque, tailThrustLimit } from '../src/physics/tail.ts';
import { deg } from '../src/physics/math.ts';

test('cold starts hold heading through the entire RPM ramp at finite and ideal drive settings', () => {
  for (const motor of [50, 90, 100]) for (const mass of [3.2, 5, 8]) for (const rpm of [1800, 2400, 3000]) {
    const r = startupExperiment({ motor, mass, rpm, duration: 10 });
    const context = `${motor}% / ${mass} kg / ${rpm} RPM`;
    assert.equal(r.crashed, false, context);
    assert.ok(r.maxHeading < .1 && r.peakYaw < 1, `${context}: ${r.maxHeading}° / ${r.peakYaw}°/s`);
    assert.ok(r.timeTo95 !== null && r.timeTo95 > 2 && r.timeTo95 < 6, context);
    assert.ok(r.peakRPM < rpm * 1.03, 'startup must not store excessive governor error');
    assert.ok(Math.abs(r.finalRPM - rpm) < 5, context);
    for (const t of r.traces) assert.ok(Math.abs(t.tailMoment) <= t.tailLimit + 1e-9, 'no invented low-RPM tail thrust');
  }
});

test('page-load initialization, settled restart, hot rearm and liftoff retain heading', () => {
  for (const motor of [90, 100]) for (const mode of [{ resetAfterTune: false }, { settled: true }, { rearm: true }, { takeoff: true }]) {
    const r = startupExperiment({ motor, ...mode });
    assert.equal(r.crashed, false);
    assert.ok(r.maxHeading < .1 && r.peakYaw < 1);
    if ('takeoff' in mode) assert.ok(!r.grounded && r.finalHeight > 2, 'static friction must release on takeoff');
  }
});

test('startup correction converges at smaller steps instead of relying on a frame-dependent lock', () => {
  for (const motor of [90, 100]) {
    const a = startupExperiment({ motor }), b = startupExperiment({ motor, dt: .001 });
    assert.ok(a.maxHeading < .1 && b.maxHeading < .1);
    assert.ok(Math.abs(a.timeTo95! - b.timeTo95!) < .03);
    assert.ok(Math.abs(a.peakRPM - b.peakRPM) < 2);
  }
});

test('shaft torque remains balanced on startup, and unsupported low-RPM airframes can still yaw', () => {
  for (const motor of [90, 100]) {
    const sim = new HelicopterSimulation(), input = defaultInput();
    applyAircraft(sim, input, { ...defaultAircraft(), motorTorque: motor });
    sim.reset(); sim.state.position.y = 1000; input.motor = true;
    let peakYaw = 0;
    for (let k = 0; k < 500; k++) {
      const previousSpeed = sim.state.rotorSpeed, dt = .002;
      sim.step(dt, input);
      const s = sim.state, p = sim.params;
      const accelerating = p.rotor.inertia * (s.rotorSpeed - previousSpeed) / dt;
      assert.ok(Math.abs(s.mainRotorTorque - s.aerodynamicTorque - accelerating) < 1e-8);
      const losses = tailShaftTorque(s.tailForce, previousSpeed, p) + (previousSpeed > 0 ? p.motor.friction : 0);
      assert.ok(Math.abs(s.motorTorque - s.mainRotorTorque - losses) < 1e-8);
      assert.ok(Math.abs(s.tailForce) <= tailThrustLimit(previousSpeed, p) + 1e-9);
      peakYaw = Math.max(peakYaw, Math.abs(deg(s.rates.y)));
    }
    assert.ok(peakYaw > 5, 'airborne zero-speed tail must not secretly lock heading');
    assert.equal(sim.state.crashed, false);
  }
});
