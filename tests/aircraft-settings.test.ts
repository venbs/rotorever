import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAircraft, neutralAerodynamics, defaultAircraft, loadAircraft, validAircraft, aircraftStorageKey, type AerodynamicsProfile } from '../src/aircraft-settings.ts';
import { defaultInput, HelicopterSimulation } from '../src/physics/simulator.ts';
import { parameters } from '../src/physics/parameters.ts';
import { deg, rad, vec } from '../src/physics/math.ts';
import { rotorLoads } from '../src/physics/rotor.ts';

test('first launch and invalid storage use the applied Chrome tune, including zero gains', () => {
  const captured = {
    mass: 2.8, rpm: 2150, motorTorque: 50, pitch: 12,
    rates: { cyclic: 350, yaw: 650, expo: .4 },
    aerodynamics: { liftGain: 70, axialDamping: 120, bodyDrag: 100 },
    fbl: {
      roll: { p: 50, i: 30, d: 0, ff: 150, b: 40 },
      pitch: { p: 50, i: 30, d: 0, ff: 150, b: 40 },
      yaw: { p: 85, i: 30, d: .35, ff: 0, b: 40 },
      dCutoff: 60, bCutoff: 25, relaxCutoff: 12,
      errorRotation: true, errorRotationGain: 100,
    },
  };
  assert.deepEqual(defaultAircraft(), captured);
  assert.deepEqual(loadAircraft(null), captured);
  for (const json of [null, '{broken', '{}', 'null']) {
    const storage = { getItem: () => json, setItem() {} };
    assert.deepEqual(loadAircraft(storage), captured, 'missing/invalid legacy PID must not replace the app preset');
  }
  const changed = defaultAircraft(); changed.fbl.roll.p = 120; changed.aerodynamics.liftGain = 150;
  assert.deepEqual(defaultAircraft(), captured, 'edits must not mutate future defaults');
});

test('the Chrome preset reaches the physics model and survives a saved-profile round trip', () => {
  const profile = defaultAircraft();
  const storage = { getItem: (key: string) => key === aircraftStorageKey ? JSON.stringify(profile) : null, setItem() {} };
  const restored = loadAircraft(storage), sim = new HelicopterSimulation(), input = defaultInput();
  assert.deepEqual(restored, profile);
  applyAircraft(sim, input, restored);
  assert.equal(sim.params.mass, 2.8); assert.equal(input.targetRPM, 2150);
  assert.equal(sim.params.motor.torquePercent, 50);
  assert.equal(sim.params.rotor.collectiveGain, parameters.rotor.collectiveGain * .7);
  assert.equal(sim.params.rotor.axialGain, parameters.rotor.axialGain * 1.2);
  assert.deepEqual(input.fbl, profile.fbl); assert.deepEqual(input.rates, profile.rates);
  // Exercise a cold start with the actual shipped preset, independently of the
  // fixed historical benchmark configuration.
  sim.reset(); input.motor = true;
  for (let k = 0; k < 5000; k++) sim.step(.002, input);
  assert.equal(sim.state.crashed, false);
  assert.ok(Math.abs(sim.state.rotorSpeed * 30 / Math.PI - 2150) < 5);
  assert.ok(Math.abs(deg(sim.state.rates.y)) < 1);
});

test('legacy PID and rates migrate intact; unified settings take precedence', () => {
  const old = defaultAircraft(); old.fbl.roll.p = 150; old.fbl.roll.ff = 200; old.rates.yaw = 700;
  const values = new Map([['heli-lab.fbl.v1', JSON.stringify(old.fbl)], ['heli-lab.rates.v1', JSON.stringify(old.rates)]]);
  const store = { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v); } };
  assert.deepEqual(loadAircraft(store), old);
  old.mass = 4; old.pitch = 15; old.rpm = 2300; values.set(aircraftStorageKey, JSON.stringify(old));
  assert.deepEqual(loadAircraft(store), old);
  const { motorTorque, ...beforeMotorControl } = old;
  values.set(aircraftStorageKey, JSON.stringify(beforeMotorControl));
  assert.deepEqual(loadAircraft(store), old, 'adding the motor control must preserve the existing unified tune');
  old.motorTorque = 100; values.set(aircraftStorageKey, JSON.stringify(old));
  assert.deepEqual(loadAircraft(store), old, 'maximum motor setting survives reload');
  values.set(aircraftStorageKey, '{bad'); assert.equal(loadAircraft(store).fbl.roll.p, 150);
  assert.deepEqual(loadAircraft({ getItem() { throw Error(); }, setItem() {} }), defaultAircraft());
});

test('weight, governor target, symmetric pitch range and rates affect the actual simulation', () => {
  const sim = new HelicopterSimulation(), input = defaultInput(), p = defaultAircraft();
  p.mass = 6.4; p.rpm = 2300; p.pitch = 15; p.rates.cyclic = 450;
  applyAircraft(sim, input, p);
  assert.equal(sim.params.mass, 6.4); assert.equal(sim.params.inertia.x, parameters.inertia.x * 2);
  assert.equal(parameters.mass, 3.2, 'editing a simulation must not mutate baseline parameters');
  input.collective = sim.hover(input.targetRPM); sim.state.position.y = 100; input.motor = true;
  assert.ok(Math.abs(sim.state.rotorSpeed * 30 / Math.PI - 2300) < 1e-8);
  assert.ok(Math.abs(sim.state.thrust - 6.4 * parameters.gravity) < 1);
  input.collective = -1; input.roll = 1;
  for (let i = 0; i < 15; i++) sim.step(0.004, input);
  assert.ok(Math.abs(deg(sim.state.collective) + 15) < 1e-8);
  assert.ok(Math.abs(deg(sim.state.rateTarget.x) - 450) < 1e-8);
  input.collective = 1;
  for (let i = 0; i < 15; i++) sim.step(0.004, input);
  assert.ok(Math.abs(deg(sim.state.collective) - 15) < 1e-8);
});

test('invalid aircraft settings are rejected before any parameters are changed', () => {
  const sim = new HelicopterSimulation(), input = defaultInput();
  for (const patch of [{ mass: NaN }, { mass: 0 }, { pitch: 90 }, { rpm: 5000 }, { motorTorque: NaN }, { motorTorque: 0 }, { motorTorque: 101 }, { motorTorque: null }, { rates: null }, { fbl: {} }]) {
    const p = { ...defaultAircraft(), ...patch };
    assert.equal(validAircraft(p), false);
    assert.throws(() => applyAircraft(sim, input, p as ReturnType<typeof defaultAircraft>));
    assert.equal(sim.params.mass, parameters.mass);
  }
});

test('older aircraft tunes gain neutral aerodynamics without losing the pilot settings', () => {
  const tune = defaultAircraft(); tune.mass = 4.35; tune.rpm = 2250; tune.motorTorque = 100;
  tune.aerodynamics = neutralAerodynamics();
  tune.pitch = 14; tune.rates.cyclic = 420; tune.fbl.pitch.p = 130;
  const { aerodynamics, ...old } = tune;
  let json = JSON.stringify(old);
  const storage = { getItem: (key: string) => key === aircraftStorageKey ? json : null, setItem(_key: string, value: string) { json = value; } };
  assert.deepEqual(loadAircraft(storage), tune);
  json = JSON.stringify({ ...old, aerodynamics: { bodyDrag: 65 } });
  assert.deepEqual(loadAircraft(storage), { ...tune, aerodynamics: { ...neutralAerodynamics(), bodyDrag: 65 } });
  tune.aerodynamics = { liftGain: 125, axialDamping: 80, bodyDrag: 65 };
  storage.setItem(aircraftStorageKey, JSON.stringify(tune));
  assert.deepEqual(loadAircraft(storage), tune, 'all new controls survive a storage round trip');
});

test('old unified tunes gain piro defaults; custom piro settings persist and reach the controller', () => {
  const tune = defaultAircraft(); tune.mass = 4.35; tune.rpm = 2250; tune.fbl.pitch.p = 130;
  const { errorRotation, errorRotationGain, ...legacyFbl } = tune.fbl;
  let json = JSON.stringify({ ...tune, fbl: legacyFbl });
  const storage = { getItem: (key: string) => key === aircraftStorageKey ? json : null, setItem(_key: string, value: string) { json = value; } };
  assert.deepEqual(loadAircraft(storage), tune);
  tune.fbl.errorRotation = false; tune.fbl.errorRotationGain = 85;
  storage.setItem(aircraftStorageKey, JSON.stringify(tune));
  const restored = loadAircraft(storage);
  assert.deepEqual(restored, tune);
  const sim = new HelicopterSimulation(), input = defaultInput();
  applyAircraft(sim, input, restored);
  assert.equal(input.fbl.errorRotation, false); assert.equal(input.fbl.errorRotationGain, 85);
  restored.fbl.errorRotationGain = 50;
  assert.equal(input.fbl.errorRotationGain, 85, 'applied profiles must be independent copies');
  for (const fbl of [{ ...tune.fbl, errorRotation: null }, { ...tune.fbl, errorRotationGain: 151 }]) {
    assert.equal(validAircraft({ ...tune, fbl }), false);
    assert.throws(() => applyAircraft(sim, input, { ...tune, fbl } as typeof tune));
    assert.equal(input.fbl.errorRotationGain, 85, 'invalid piro settings must not change the active tune');
  }
});

function aerodynamicSetup(aerodynamics = neutralAerodynamics()) {
  const sim = new HelicopterSimulation(), input = defaultInput(), profile = { ...defaultAircraft(), aerodynamics };
  applyAircraft(sim, input, profile);
  return { sim, input, profile };
}

test('lift gain changes signed rotor thrust and shaft load; reapplying never compounds it', () => {
  const reference = aerodynamicSetup(), stronger = aerodynamicSetup({ ...neutralAerodynamics(), liftGain: 150 });
  const loads = (sim: HelicopterSimulation, sign: number) => rotorLoads(2400 * Math.PI / 30, sign * rad(6), sign * 4, vec(), sim.params);
  const initial = loads(reference.sim, 1), boosted = loads(stronger.sim, 1);
  assert.ok(boosted.thrust > initial.thrust * 1.4 && boosted.thrust < initial.thrust * 1.7);
  assert.ok(boosted.torque > initial.torque, 'extra lift must also load the power system');
  assert.ok(Math.abs(loads(stronger.sim, -1).thrust + boosted.thrust) < 1e-8);
  applyAircraft(stronger.sim, stronger.input, stronger.profile);
  assert.deepEqual(loads(stronger.sim, 1), boosted);
  applyAircraft(stronger.sim, stronger.input, { ...stronger.profile, aerodynamics: neutralAerodynamics() });
  assert.deepEqual(loads(stronger.sim, 1), initial, 'restoring 100% restores the original force model');
  assert.equal(parameters.rotor.collectiveGain, 1521, 'reference parameters were mutated');
});

test('axial damping adjusts rotor braking in both directions without changing stationary lift', () => {
  const at = (damping: number, velocity: number) => {
    const { sim } = aerodynamicSetup({ ...neutralAerodynamics(), axialDamping: damping });
    return rotorLoads(2400 * Math.PI / 30, 0, 0, vec(0, velocity, 0), sim.params).thrust;
  };
  for (const velocity of [-4, 4]) {
    assert.equal(at(0, velocity), 0);
    assert.ok(at(100, velocity) * velocity < 0, 'axial force must oppose motion');
    assert.ok(Math.abs(at(200, velocity) - 2 * at(100, velocity)) < 1e-8);
  }
  const thrust = [0, 100, 200].map(axialDamping => {
    const { sim } = aerodynamicSetup({ ...neutralAerodynamics(), axialDamping });
    return rotorLoads(2400 * Math.PI / 30, rad(6), 4, vec(), sim.params).thrust;
  });
  assert.equal(thrust[0], thrust[1]); assert.equal(thrust[1], thrust[2]);
});

test('body drag changes actual translation acceleration independently of rotor damping', () => {
  const acceleration = (bodyDrag: number) => {
    const { sim, input } = aerodynamicSetup({ ...neutralAerodynamics(), bodyDrag });
    sim.params.gravity = 0; sim.state.position.y = 100; sim.state.velocity = vec(10, 0, 0);
    // Motor off, no cyclic: forward acceleration isolates airframe drag.
    sim.step(.002, input);
    assert.equal(sim.params.rotor.axialGain, parameters.rotor.axialGain);
    return sim.state.acceleration.x;
  };
  assert.equal(acceleration(0), 0);
  assert.ok(acceleration(100) < -.3);
  assert.ok(Math.abs(acceleration(200) - 2 * acceleration(100)) < 1e-10);
});

test('invalid aerodynamic settings are rejected before mutating the simulation', () => {
  const { sim, input, profile } = aerodynamicSetup();
  const original = structuredClone(sim.params);
  for (const aerodynamics of [null, {}, { ...neutralAerodynamics(), liftGain: 0 }, { ...neutralAerodynamics(), axialDamping: -1 },
    { ...neutralAerodynamics(), bodyDrag: 301 }, { ...neutralAerodynamics(), bodyDrag: NaN }, { ...neutralAerodynamics(), liftGain: '150' }]) {
    const invalid = { ...profile, mass: 2, aerodynamics: aerodynamics as AerodynamicsProfile };
    assert.equal(validAircraft(invalid), false);
    assert.throws(() => applyAircraft(sim, input, invalid));
    assert.deepEqual(sim.params, original);
  }
});
