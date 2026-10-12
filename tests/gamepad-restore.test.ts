import test from 'node:test';
import assert from 'node:assert/strict';
import { GamepadController, ProfileStore, defaultProfile, deviceKey, mapPad, type PadReading, type ProfileStorage } from '../src/gamepad.ts';

const radio = (overrides: Partial<PadReading> = {}): PadReading => ({
  id: 'Saved USB radio', index: 0, connected: true, mapping: '',
  axes: [.3, -.4, .2, .6, -1], buttons: [], ...overrides,
});
function storage() {
  const values = new Map<string, string>();
  let reads = 0;
  const backend: ProfileStorage = {
    getItem: key => { reads++; return values.get(key) ?? null; },
    setItem: (key, value) => { values.set(key, value); },
  };
  return { store: new ProfileStore(backend), values, reads: () => reads };
}

test('refresh restores the saved calibration and arming switch on first poll, regardless of device index', () => {
  const { store, reads } = storage(), original = radio(), profile = defaultProfile(original);
  profile.channels.roll = { axis: 0, inverted: true, deadzone: .04, min: -.8, center: .1, max: .9 };
  profile.channels.pitch.axis = 3; profile.channels.yaw.axis = 1;
  profile.arm = { source: 'axis', index: 4, inverted: false };
  store.save(original, profile);
  let pad = radio({ index: 4 });
  // Fresh controller represents a page reload, without opening/saving the panel.
  const controller = new GamepadController(() => [pad], () => assert.fail('unexpected loss'), store);
  controller.poll();
  assert.equal(controller.active, true);
  assert.equal(controller.activeIndex, 4);
  assert.deepEqual(controller.profileFor(pad), profile);
  assert.deepEqual(controller.output, mapPad(pad, profile));
  assert.equal(controller.output.motor, false);
  const firstReads = reads();
  pad = radio({ index: 4, axes: [.7, .2, -.5, -.8, 1] });
  for (let i = 0; i < 120; i++) controller.poll();
  assert.deepEqual(controller.output, mapPad(pad, profile));
  assert.equal(controller.output.motor, true);
  assert.equal(reads(), firstReads, 'input polling must not repeatedly read/parse localStorage');
});

test('existing pre-fix profiles restore when the browser exposes a device later', () => {
  const { store, values } = storage(), pad = radio(), profile = defaultProfile(pad);
  const legacy = structuredClone(profile) as Partial<typeof profile>; delete legacy.arm;
  // The old installation has a saved profile but no preferred-device entry.
  values.set(`heli-lab.gamepad.v1:${encodeURIComponent(deviceKey(pad))}`, JSON.stringify(legacy));
  let devices: PadReading[] = [];
  const controller = new GamepadController(() => devices, () => assert.fail('unexpected loss'), store);
  controller.poll(); controller.poll(); assert.equal(controller.active, false);
  devices = [pad]; controller.poll();
  assert.equal(controller.active, true);
  assert.deepEqual(controller.profileFor(pad), profile);
});

test('last saved device wins; another saved radio cannot take over while it is absent', () => {
  const { store } = storage(), a = radio(), b = radio({ id: 'Preferred radio', index: 2 });
  store.save(a, defaultProfile(a)); store.save(b, defaultProfile(b));
  let devices = [a];
  const controller = new GamepadController(() => devices, () => {}, store);
  controller.poll(); assert.equal(controller.active, false);
  devices = [a, b]; controller.poll();
  assert.equal(controller.activeName, b.id);
  // An unexpected disconnect stops the session instead of silently switching radios.
  devices = [a]; controller.poll(); assert.equal(controller.active, false);
  devices = [a, b]; controller.poll(); assert.equal(controller.active, false);
  const refreshed = new GamepadController(() => devices, () => {}, store);
  refreshed.poll(); assert.equal(refreshed.activeName, b.id);
});

test('manual disable survives refresh and saving/enabling restores automatic startup', () => {
  const { store } = storage(), pad = radio(), profile = defaultProfile(pad);
  store.save(pad, profile);
  const make = () => new GamepadController(() => [pad], () => {}, store);
  const first = make(); first.poll(); first.disable(); first.poll(); assert.equal(first.active, false);
  const second = make(); second.poll(); assert.equal(second.active, false);
  second.enable(pad, profile); store.save(pad, profile);
  const third = make(); third.poll(); assert.equal(third.active, true);
});

test('unknown, corrupt, ambiguous or unreadable profiles never auto-enable default mappings', () => {
  const pad = radio(), { store, values } = storage();
  const run = (devices = [pad], source = store) => {
    const controller = new GamepadController(() => devices, () => {}, source);
    controller.poll(); assert.equal(controller.active, false); assert.deepEqual(controller.output, {});
  };
  run();
  values.set(`heli-lab.gamepad.v1:${encodeURIComponent(deviceKey(pad))}`, '{broken'); run();
  store.save(pad, defaultProfile(pad));
  run([pad, radio({ index: 1 })]);
  run([radio({ id: 'Unknown radio' })]);
  run([pad], new ProfileStore({ getItem() { throw Error('blocked'); }, setItem() {} }));
});

test('invalid initial samples wait for a valid reading without asking for another save', () => {
  const { store } = storage(), initial = radio(), profile = defaultProfile(initial);
  profile.arm = { source: 'axis', index: 4, inverted: true }; store.save(initial, profile);
  let pad = radio({ axes: [0, 0, 0, 0, NaN] });
  const controller = new GamepadController(() => [pad], () => assert.fail('not yet enabled'), store);
  controller.poll(); assert.equal(controller.active, false);
  pad = radio(); controller.poll();
  assert.equal(controller.active, true); assert.equal(controller.output.motor, true);
});
