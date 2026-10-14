import test from 'node:test';
import assert from 'node:assert/strict';
import { GamepadController, ProfileStore, defaultProfile, deviceKey, mapPad, radioRecognition, type PadReading, type ProfileStorage } from '../src/gamepad.ts';

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
  return { store: new ProfileStore(backend), backend, values, reads: () => reads };
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

test('last used connected device wins; an absent preference never blocks another radio', () => {
  const { store } = storage(), a = radio(), b = radio({ id: 'Preferred radio', index: 2 });
  store.save(a, defaultProfile(a)); store.save(b, defaultProfile(b));
  let devices = [a, b];
  const controller = new GamepadController(() => devices, () => {}, store);
  controller.poll();
  assert.equal(controller.activeName, b.id);
  // An unexpected disconnect stops the session instead of silently switching radios.
  devices = [a]; controller.poll(); controller.poll(); assert.equal(controller.active, false);
  const otherSession = new GamepadController(() => devices, () => {}, store);
  otherSession.poll(); assert.equal(otherSession.activeName, a.id);
  devices = [a, b]; controller.poll(); assert.equal(controller.activeName, b.id);
  const refreshed = new GamepadController(() => devices, () => {}, store);
  refreshed.poll(); assert.equal(refreshed.activeName, b.id);
});

test('manual keyboard selection lasts until reconnect or refresh, without disabling future startup', () => {
  const { store } = storage(), pad = radio(), profile = defaultProfile(pad);
  store.save(pad, profile);
  let devices = [pad];
  const make = () => new GamepadController(() => devices, () => {}, store);
  const first = make(); first.poll(); first.disable();
  for (let i = 0; i < 120; i++) first.poll();
  assert.equal(first.active, false);
  assert.equal(first.connectionStatus, 'keyboard');
  const second = make(); second.poll(); assert.equal(second.active, true);
  devices = []; first.poll();
  devices = [pad]; first.poll(); assert.equal(first.active, true);
  const third = make(); third.poll(); assert.equal(third.active, true);
});

test('a first-time HID radio auto-connects on exposure with AETR and CH6, without opening settings', () => {
  const { store, reads } = storage();
  const pad = radio({axes: [.5, -.5, .8, -1, 1, -1]});
  let devices: PadReading[] = [];
  const controller = new GamepadController(() => devices, () => assert.fail('unexpected disconnect'), store);
  controller.poll(); assert.equal(controller.active, false);
  devices = [pad]; controller.poll();
  assert.equal(controller.active, true);
  assert.deepEqual(controller.output, mapPad(pad, defaultProfile(pad)));
  assert.equal(controller.output.collective, .8);
  assert.equal(controller.output.motor, false, 'CH5 must not arm the motor');
  const firstReads = reads();
  pad.axes = [-.5, .5, -.8, 1, -1, 1];
  for (let i = 0; i < 120; i++) controller.poll();
  assert.equal(controller.output.collective, -.8);
  assert.equal(controller.output.motor, true);
  assert.equal(reads(), firstReads);
  const refreshed = new GamepadController(() => devices, () => {}, store);
  refreshed.poll(); assert.deepEqual(refreshed.output, controller.output);
});

test('new or damaged storage does not prevent a radio from flying with defaults', () => {
  const pad = radio(), { store, values } = storage();
  values.set(`heli-lab.gamepad.v1:${encodeURIComponent(deviceKey(pad))}`, '{broken');
  const blocked = new ProfileStore({ getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); } });
  for (const source of [store, blocked, new ProfileStore(null)]) {
    const controller = new GamepadController(() => [pad], () => {}, source);
    controller.poll(); assert.equal(controller.active, true);
    assert.deepEqual(controller.output, mapPad(pad, defaultProfile(pad)));
  }
});

test('ambiguous radios need selection, and button-only devices do not take flight control', () => {
  const pad = radio(), { store } = storage();
  for (const devices of [[pad, radio({ index: 1 })], [radio({axes: [], buttons:[{value:0, pressed:false}]})]]) {
    const controller = new GamepadController(() => devices, () => {}, store);
    controller.poll(); assert.equal(controller.active, false); assert.deepEqual(controller.output, {});
  }
});

test('disconnect closes motor output and reconnect restores the same tune at a new index', () => {
  const { store } = storage(), pad = radio({axes:[.5, 0, .8, 0, 0, 1]}), profile = defaultProfile(pad);
  profile.channels.roll.inverted = true;
  store.save(pad, profile);
  let devices = [pad], losses = 0;
  const controller = new GamepadController(() => devices, () => { losses++; }, store);
  controller.poll(); assert.equal(controller.output.motor, true);
  devices = []; controller.poll(); controller.poll();
  assert.deepEqual(controller.output, {}); assert.equal(losses, 1);
  const returned = {...pad, index:4, axes:[.5, 0, .8, 0, 0, -1]};
  devices = [returned]; controller.poll();
  assert.equal(controller.activeIndex, 4); assert.equal(controller.output.motor, false);
  assert.deepEqual(controller.profileFor(returned), profile);
  assert.equal(losses, 1);
});

test('old persistent keyboard preferences and corrupt history no longer block auto connection', () => {
  const { store, values } = storage(), pad = radio();
  values.set('heli-lab.gamepad.preferred.v1', 'disabled');
  values.set('heli-lab.gamepad.known.v1', '{broken');
  const controller = new GamepadController(() => [pad], () => {}, store);
  controller.poll();
  assert.equal(controller.active, true);
  assert.equal(controller.automatic, true);
  assert.equal(store.preferredDevice(), deviceKey(pad));
});

test('firmware USB identity works across manufacturer names and browser ID formats', () => {
  for (const id of ['Unknown Brand (Vendor: 1209 Product: 4f54)', '1209-4f54-USB Joystick', '1209:4F54', 'EdgeTX Joystick', 'OpenTX Joystick']) {
    assert.equal(radioRecognition(radio({ id })), 'firmware', id);
  }
  assert.equal(radioRecognition(radio({ id: 'Generic USB HID' })), 'multi-axis');
  assert.equal(radioRecognition(radio({ id: '1209:1234', mapping: 'standard' })), null);
  assert.equal(radioRecognition(radio({ axes: [0, 0] })), null);
});

test('a new firmware radio wins over unknown HID devices and standard gamepads', () => {
  const { store } = storage();
  const transmitter = radio({ id: 'TX (Vendor: 1209 Product: 4f54)', index: 3 });
  const devices = [radio({ id: 'Standard gamepad', mapping: 'standard' }), radio({ id: 'Generic joystick', index: 1 }), transmitter];
  const controller = new GamepadController(() => devices, () => {}, store);
  controller.poll(); assert.equal(controller.activeIndex, 3);
  // A newly plugged device, even one with a saved profile, cannot steal control.
  const other = radio({ id: 'Other saved transmitter', index: 4 });
  store.save(other, defaultProfile(other)); devices.push(other);
  controller.poll(); assert.equal(controller.activeIndex, 3);
});

test('manual device selection is remembered without saving a profile, across reloads and index changes', () => {
  const { store, backend, values } = storage();
  const pad = radio({ id: 'Standard gamepad', mapping: 'standard' });
  const controller = new GamepadController(() => [pad], () => {}, store);
  controller.poll(); assert.equal(controller.active, false); assert.equal(controller.connectionStatus, 'select');
  controller.enable(pad, defaultProfile(pad));
  assert.equal(controller.automatic, false);
  assert.equal(values.has(`heli-lab.gamepad.v1:${encodeURIComponent(deviceKey(pad))}`), false, 'selection must not persist an unsaved calibration');
  const returned = { ...pad, index: 5 };
  const next = new GamepadController(() => [radio(), returned], () => {}, new ProfileStore(backend));
  next.poll(); assert.equal(next.activeIndex, 5); assert.equal(next.automatic, true);
});

test('usage history restores an older device when the latest one is absent', () => {
  const { store, backend } = storage();
  const a = radio({ id: 'Remembered A', mapping: 'standard' }), b = radio({ id: 'Remembered B', mapping: 'standard' });
  store.rememberDevice(a); store.rememberDevice(b);
  const controller = new GamepadController(() => [a, radio({ index: 2 })], () => {}, new ProfileStore(backend));
  controller.poll(); assert.equal(controller.activeName, a.id);
});

test('identical model IDs remain ambiguous even after one was previously used', () => {
  const { store, reads } = storage(), a = radio(), b = radio({ index: 1 });
  store.rememberDevice(a);
  const controller = new GamepadController(() => [a, b], () => {}, store);
  controller.poll(); assert.equal(controller.connectionStatus, 'ambiguous');
  const firstReads = reads();
  for (let i = 0; i < 120; i++) controller.poll();
  assert.equal(controller.active, false); assert.equal(reads(), firstReads);
  controller.enable(b, defaultProfile(b)); controller.poll(); assert.equal(controller.activeIndex, 1);
});

test('an already-connected identical radio cannot take over after the selected unit disconnects', () => {
  const { store } = storage(), a = radio(), b = radio({ index: 1 });
  let devices = [a, b], losses = 0;
  const controller = new GamepadController(() => devices, () => { losses++; }, store);
  controller.poll(); controller.enable(a, defaultProfile(a));
  devices = [b]; controller.poll(); controller.poll();
  assert.equal(controller.active, false); assert.deepEqual(controller.output, {}); assert.equal(losses, 1);
  devices = [b, { ...a, index: 5 }]; controller.poll();
  assert.equal(controller.activeIndex, 5, 'only the newly returned connection is eligible');
});

test('newly inserted radios can connect after a manual keyboard choice or disconnect', () => {
  for (const manual of [true, false]) {
    const { store } = storage(), a = radio(), b = radio({ id: 'New radio', index: 2 });
    let devices = [a], losses = 0;
    const controller = new GamepadController(() => devices, () => { losses++; }, store);
    controller.poll();
    if (manual) controller.disable();
    else { devices = []; controller.poll(); assert.deepEqual(controller.output, {}); }
    devices = manual ? [a, b] : [b]; controller.poll();
    assert.equal(controller.activeName, b.id); assert.equal(losses, manual ? 0 : 1);
  }
});

test('invalid live samples stop output once and recover without repeated storage reads', () => {
  const { store, reads } = storage();
  let pad = radio({ axes: [0, 0, 0, 0, 0, 1] }), losses = 0;
  const controller = new GamepadController(() => [pad], () => { losses++; }, store);
  controller.poll(); assert.equal(controller.output.motor, true);
  pad = { ...pad, axes: [NaN, 0, 0, 0, 0, 1] };
  controller.poll(); assert.deepEqual(controller.output, {});
  controller.poll(); const firstReads = reads();
  for (let i = 0; i < 120; i++) controller.poll();
  assert.equal(reads(), firstReads); assert.equal(losses, 1);
  assert.equal(controller.connectionStatus, 'invalid');
  pad = { ...pad, axes: [0, 0, 0, 0, 0, -1] }; controller.poll();
  assert.equal(controller.active, true); assert.equal(controller.output.motor, false);
});

test('history is bounded, validates entries, and does not reuse a tune for a changed layout', () => {
  const { store, backend, values } = storage();
  values.set('heli-lab.gamepad.known.v1', JSON.stringify([null, 'disabled', '[]', JSON.stringify(['id', -1, 0, ''])]));
  assert.deepEqual(store.knownDevices(), []);
  for (let i = 0; i < 25; i++) store.rememberDevice(radio({ id: `radio ${i}` }));
  assert.equal(new ProfileStore(backend).knownDevices().length, 20);
  const pad = radio(), profile = defaultProfile(pad); profile.channels.roll.inverted = true;
  store.save(pad, profile);
  const changed = { ...pad, axes: [0, 0, 0, 0, 0, -1] };
  const controller = new GamepadController(() => [changed], () => {}, new ProfileStore(backend));
  controller.poll();
  assert.deepEqual(controller.profileFor(changed), defaultProfile(changed));
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
