import test from 'node:test';
import assert from 'node:assert/strict';
import { parameters } from '../src/physics/parameters.ts';
import { rad, vec, norm, scale } from '../src/physics/math.ts';
import { rotorLoads } from '../src/physics/rotor.ts';
import { bladeCyclicPitch, maneuverLoads, rotorSeparationTarget } from '../src/physics/rotor-maneuver.ts';
import { maneuverExperiment, fixedFlowLoad } from '../scripts/maneuver-load-benchmark.ts';

const close = (a: number, b: number, epsilon = 1e-9) => assert.ok(Math.abs(a - b) <= epsilon, `${a} != ${b}`);
const p = parameters, omega = 2400 * Math.PI / 30;

test('collective and cyclic combine nonlinearly at high local incidence, with attached-flow cyclic cost below stall', () => {
  const mild = fixedFlowLoad(6, 3), stronger = fixedFlowLoad(6, 6);
  close(mild.separation, 0); close(stronger.separation, 0);
  assert.ok(mild.addedTorque > 0, 'cyclic must cost power even before separation');
  close(stronger.addedTorque / mild.addedTorque, 4);
  const collective = fixedFlowLoad(12, 0), cyclic = fixedFlowLoad(0, 12), combined = fixedFlowLoad(12, 12);
  close(collective.separation, 0);
  assert.ok(combined.addedTorque > 3 * (collective.addedTorque + cyclic.addedTorque));
  assert.ok(combined.liftEfficiency < .9 && combined.liftEfficiency > .5);
  assert.ok(combined.thrust < collective.thrust, 'separation must reduce thrust, not just add torque');
});

test('separation depends on signed angle of attack, remains continuous, and is symmetric for inverted flow', () => {
  for (const collective of [rad(6), rad(12), rad(18)]) for (const cyclic of [0, rad(6), rad(12)]) {
    const a = rotorSeparationTarget(omega, collective, cyclic, 3, 4, p);
    const b = rotorSeparationTarget(omega, -collective, cyclic, -3, -4, p);
    close(a, b);
    assert.ok(a >= 0 && a <= 1);
  }
  const angle = p.rotor.stallAngle;
  const before = rotorSeparationTarget(omega, angle - 1e-7, 0, 0, 0, p);
  const after = rotorSeparationTarget(omega, angle + 1e-7, 0, 0, 0, p);
  assert.ok(after - before < 1e-8, 'no hard threshold impulse');
  assert.ok(rotorSeparationTarget(omega, rad(12), rad(12), 6, 4, p)
    < rotorSeparationTarget(omega, rad(12), rad(12), 0, 4, p), 'through-flow must change incidence');
});

test('separation builds and recovers without delaying attached-flow lift or inventing low-RPM power', () => {
  const base = rotorLoads(omega, rad(12), 4, vec(), p), target = rotorSeparationTarget(omega, rad(12), rad(12), 0, 4, p);
  let s = 0;
  for (let i = 0; i < 20; i++) s = maneuverLoads(base, omega, rad(12), rad(12), 0, 4, vec(0, 1, 0), vec(), s, .002, p).separation;
  assert.ok(s > target * .99 && s <= target);
  for (let i = 0; i < 150; i++) s = maneuverLoads(base, omega, 0, 0, 0, 0, vec(0, 1, 0), vec(), s, .002, p).separation;
  assert.ok(s < target * .01, 'unloaded rotor must recover');
  const attached = maneuverLoads(base, omega, rad(6), 0, 0, 4, vec(0, 1, 0), vec(), 0, .002, p);
  close(attached.thrust, base.thrust); close(attached.torque, base.torque);
  for (const speed of [0, 5, 39, 40]) {
    const passive = rotorLoads(speed, rad(18), 0, vec(), p);
    const result = maneuverLoads(passive, speed, rad(18), rad(12), 0, 0, vec(0, 1, 0), vec(6, 0, 6), 1, .002, p);
    close(result.thrust, passive.thrust); close(result.torque, passive.torque);
    close(result.workTorque, 0); close(result.dragTorque, 0);
  }
  close(bladeCyclicPitch(rad(9), rad(9), vec(14, 0, 14), 40, p), p.rotor.maxCyclicPitch);
});

test('shaft charges positive roll/pitch work using exactly the moments applied to the body', () => {
  const roll = rad(8), pitch = rad(-7), raw = vec(Math.sin(pitch), 1, Math.sin(roll));
  const disc = scale(raw, 1 / norm(raw)), rates = vec(5, 3, 4);
  const base = rotorLoads(omega, rad(6), 4, vec(), p);
  const result = maneuverLoads(base, omega, rad(6), rad(12), 0, 4, disc, rates, .2, .002, p);
  const hub = p.hubStiffness * (omega / (2100 * Math.PI / 30)) ** 2 * result.cyclicEfficiency;
  const rollMoment = p.headHeight * result.thrust * disc.z + hub * roll;
  const pitchMoment = -p.headHeight * result.thrust * disc.x - hub * pitch;
  close(result.workTorque * omega, rollMoment * rates.x + pitchMoment * rates.z);
  const braking = maneuverLoads(base, omega, rad(6), rad(12), 0, 4, disc, scale(rates, -1), .2, .002, p);
  close(braking.workTorque, 0);
});

test('combined hard cyclic and collective costs more drive and sags a finite motor, while 100% remains ideal', () => {
  for (const axis of ['pitch', 'roll'] as const) {
    const old = maneuverExperiment({ enabled: false, axis }), next = maneuverExperiment({ axis });
    assert.ok(next.minimumRPM < old.minimumRPM - 20, `${axis}: no extra maneuver loading`);
    assert.ok(next.peakLoad > old.peakLoad);
    assert.ok(next.peakSeparation > .08);
    assert.ok(next.minimumRPM > 1800 && next.finalRPM > 2380 && next.finalRPM < 2420);
    assert.ok(next.finalSeparation < .01);
    assert.ok(next.peakYaw < 2 && !next.crashed, 'added load must not break a sufficiently sized tail');
  }
  const ideal = maneuverExperiment({ motor: 100 });
  close(ideal.minimumRPM, 2400);
  assert.ok(ideal.peakLoad > 20 && ideal.peakSeparation > .2, 'ideal drive hides sag, not blade loss');
  const oldCollective = maneuverExperiment({ enabled: false, cyclic: 0 }), newCollective = maneuverExperiment({ cyclic: 0 });
  close(oldCollective.minimumRPM, newCollective.minimumRPM, 1e-6);
  const mild = maneuverExperiment({ collective: .25 });
  assert.ok(mild.minimumRPM > 2380 && mild.peakSeparation === 0, 'ordinary flips must stay crisp');
});

test('maneuver loading and recovery converge when the physics step is halved', () => {
  for (const motor of [90, 100]) for (const collective of [-1, 1]) {
    const a = maneuverExperiment({ motor, collective }), b = maneuverExperiment({ motor, collective, dt: .001 });
    assert.ok(Math.abs(a.minimumRPM - b.minimumRPM) < 5);
    assert.ok(Math.abs(a.peakLoad - b.peakLoad) < 1);
    assert.ok(Math.abs(a.finalRPM - b.finalRPM) < 2);
    assert.ok(a.peakYaw < 2 && b.peakYaw < 2);
    assert.equal(a.crashed, false); assert.equal(b.crashed, false);
  }
});
