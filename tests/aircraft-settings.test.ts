import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAircraft, defaultAircraft, loadAircraft, validAircraft, aircraftStorageKey } from '../src/aircraft-settings.ts';
import { defaultInput, HelicopterSimulation } from '../src/physics/simulator.ts';
import { parameters } from '../src/physics/parameters.ts';
import { deg } from '../src/physics/math.ts';

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
