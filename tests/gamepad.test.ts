import test from 'node:test';
import assert from 'node:assert/strict';
import { CalibrationCapture, GamepadController, ProfileStore, channels, defaultProfile, mapPad, normalizeAxis, profileErrors, type PadReading, type ProfileStorage } from '../src/gamepad.ts';

function pad(overrides: Partial<PadReading> = {}): PadReading {
  return { id: 'Test USB radio', index: 0, connected: true, mapping: '', axes: [0, 0, 0, 0], buttons: [], ...overrides };
}
function assigned(device = pad()) {
  const profile = defaultProfile(device);
  channels.forEach((c, index) => { Object.assign(profile.channels[c], { axis: index, inverted: false, deadzone: 0 }); });
  return profile;
}
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-10, `${a} != ${b}`);

test('all devices default to AETR with collective on T and independent motor arming', () => {
  for (const mapping of ['', 'standard']) {
    const device = pad({ mapping, axes: [0.5, -1, 0.7, 1] });
    const output = mapPad(device, defaultProfile(device));
    near(output.roll!, (0.5 - 0.025) / 0.975);
    near(output.pitch!, -1); near(output.collective!, 0.7); near(output.yaw!, 1);
    assert.equal(output.motor, undefined);
    assert.deepEqual(profileErrors(defaultProfile(device), device), []);
  }
});

test('calibrated asymmetric endpoints map to full scale, with independent reversal and deadzone', () => {
  const m = { axis: 0, inverted: false, deadzone: 0.1, min: -0.7, center: 0.1, max: 0.9 };
  near(normalizeAxis(-0.7, m), -1); near(normalizeAxis(0.9, m), 1);
  near(normalizeAxis(0.1, m), 0); near(normalizeAxis(0.15, m), 0);
  near(normalizeAxis(0.54, m), 0.5); near(normalizeAxis(-0.34, m), -0.5);
  near(normalizeAxis(-2, m), -1); near(normalizeAxis(2, m), 1);
  near(normalizeAxis(0.54, { ...m, inverted: true }), -0.5);
  near(normalizeAxis(NaN, m), 0);
});

test('assignment rejects duplicate axes, missing axes, invalid ranges and deadzones', () => {
  const p = assigned();
  assert.deepEqual(profileErrors(p, pad()), []);
  p.channels.pitch.axis = 0;
  assert.match(profileErrors(p, pad()).join(), /同一通道/);
  p.channels.pitch.axis = 9;
  assert.match(profileErrors(p, pad()).join(), /不存在/);
  p.channels.pitch.axis = null;
  p.channels.roll.center = 1;
  assert.match(profileErrors(p, pad()).join(), /校准范围/);
  p.channels.roll.center = 0; p.channels.roll.deadzone = NaN;
  assert.match(profileErrors(p, pad()).join(), /死区/);
});

test('calibration requires both endpoints for every assigned channel and commits atomically', () => {
  const device = pad({ axes: [0.1, 0.2, -0.1, 0.5] }), profile = assigned(device);
  const before = structuredClone(profile), capture = new CalibrationCapture(device, profile);
  capture.observe(pad({ axes: [-0.8, -0.7, -0.9, 0] }));
  assert.equal(capture.incomplete.length, 4);
  assert.throws(() => capture.finish(), /两端/);
  capture.observe(pad({ axes: [0.9, 0.85, 0.7, 1] }));
  assert.equal(capture.incomplete.length, 0);
  const calibrated = capture.finish();
  assert.deepEqual(profile, before, 'draft is untouched until caller accepts result');
  assert.deepEqual(calibrated.channels.collective, { axis: 3, inverted: false, deadzone: 0, min: 0, center: 0.5, max: 1 });
  near(mapPad(pad({ axes: [0.1, 0.2, -0.1, 0.5] }), calibrated).collective!, 0);
  assert.deepEqual(mapPad(pad({ axes: [-0.8, -0.7, -0.9, 0] }), calibrated), { roll: -1, pitch: -1, yaw: -1, collective: -1 });
});

test('calibration ignores unassigned channels and rejects device replacement or invalid input', () => {
  const device = pad(), profile = assigned(); profile.channels.collective.axis = null;
  const capture = new CalibrationCapture(device, profile);
  capture.observe(pad({ axes: [-1, -1, -1, 0] })); capture.observe(pad({ axes: [1, 1, 1, 0] }));
  assert.equal(capture.incomplete.length, 0);
  assert.equal(capture.finish().channels.collective.axis, null);
  assert.throws(() => capture.observe(pad({ id: 'Replacement' })), /断开/);
  assert.throws(() => capture.observe(pad({ index: 1 })), /断开/);
  assert.throws(() => capture.observe(pad({ connected: false })), /断开/);
  assert.throws(() => capture.observe(pad({ axes: [NaN, 0, 0, 0] })), /无效/);
});

test('profiles persist by device identity across index changes and tolerate damaged/blocked storage', () => {
  const values = new Map<string, string>();
  const storage: ProfileStorage = { getItem: k => values.get(k) ?? null, setItem: (k, v) => { values.set(k, v); } };
  const store = new ProfileStore(storage), profile = assigned(); profile.channels.roll.inverted = true;
  assert.equal(store.save(pad(), profile), true);
  assert.deepEqual(store.load(pad({ index: 3 })), profile);
  assert.deepEqual(store.load(pad({ id: 'Different radio' })), defaultProfile(pad()));
  for (const key of values.keys()) values.set(key, '{broken');
  assert.deepEqual(store.load(pad()), defaultProfile(pad()));
  const damaged = structuredClone(profile); delete (damaged.channels.roll as Partial<typeof damaged.channels.roll>).max;
  for (const key of values.keys()) values.set(key, JSON.stringify(damaged));
  assert.deepEqual(store.load(pad()), defaultProfile(pad()));
  const blocked = new ProfileStore({ getItem() { throw Error(); }, setItem() { throw Error(); } });
  assert.equal(blocked.save(pad(), profile), false);
  assert.deepEqual(blocked.load(pad()), defaultProfile(pad()));
  assert.equal(new ProfileStore(null).save(pad(), profile), false);
});

test('polling reads fresh selected device, handles sparse slots and leaves unassigned input untouched', () => {
  let devices: (PadReading | null)[] = [null, pad({ index: 1 }), pad({ id: 'Second radio', index: 2 })];
  const controller = new GamepadController(() => devices, () => assert.fail('unexpected disconnect'));
  controller.poll(); assert.equal(controller.devices.length, 2);
  const p = assigned(); p.channels.pitch.axis = null;
  controller.enable(devices[1]!, p);
  p.channels.roll.inverted = true; // Unsaved UI draft must not affect the active mapping.
  devices = [null, pad({ index: 1, axes: [0.3, 0.7, -0.5, -0.8] })]; controller.poll();
  assert.deepEqual(controller.output, { roll: 0.3, yaw: -0.5, collective: -0.8 });
  const copy = controller.profileFor(devices[1]!)!; copy.channels.roll.axis = null;
  assert.equal(controller.profileFor(devices[1]!)!.channels.roll.axis, 0);
  controller.disable(); controller.poll(); assert.deepEqual(controller.output, {});
});

test('disconnect reports loss once, reconnect restores the selected radio, index reuse never takes over', () => {
  let devices: PadReading[] = [pad()], loss = 0;
  const controller = new GamepadController(() => devices, () => { loss++; });
  controller.poll(); controller.enable(devices[0], assigned());
  devices = []; controller.poll(); controller.poll();
  assert.equal(loss, 1); assert.equal(controller.active, false); assert.deepEqual(controller.output, {});
  devices = [pad()]; controller.poll(); assert.equal(controller.active, true);
  controller.enable(devices[0], assigned());
  devices = [pad({ id: 'Different radio in same slot' })]; controller.poll();
  assert.equal(loss, 2); assert.equal(controller.active, false);
  assert.throws(() => controller.enable(pad(), assigned()), /断开/);
});

test('invalid samples and Gamepad API access failure disable the active controller', () => {
  let device = pad(), throws = false, loss = 0;
  const controller = new GamepadController(() => { if (throws) throw Error('Permissions Policy'); return [device]; }, () => { loss++; });
  controller.poll(); controller.enable(device, assigned());
  device = pad({ axes: [NaN, 0, 0, 0] }); controller.poll();
  assert.equal(loss, 1); assert.equal(controller.active, false);
  assert.throws(() => controller.enable(device, assigned()), /无效/);
  device = pad(); controller.poll(); controller.enable(device, assigned());
  throws = true; controller.poll(); controller.poll();
  assert.equal(loss, 2); assert.equal(controller.active, false); assert.match(controller.error, /浏览器/);
});

test('arming axis/button controls motor, supports reversal and rejects flight-axis reuse', () => {
  const device = pad({ axes: [0, 0, 0, 0, -1], buttons: [{ value: 0, pressed: false }] });
  const profile = defaultProfile(device); profile.arm = { source: 'axis', index: 4, inverted: false };
  assert.deepEqual(profileErrors(profile, device), []);
  assert.equal(mapPad(device, profile).motor, false);
  const high = { ...device, axes: [0, 0, 0, 0, 1] };
  assert.equal(mapPad(high, profile).motor, true);
  assert.equal(mapPad({ ...device, axes: [0, 0, 0, 0, 0.01] }, profile, false).motor, false);
  assert.equal(mapPad({ ...device, axes: [0, 0, 0, 0, -0.01] }, profile, true).motor, true);
  profile.arm.inverted = true;
  assert.equal(mapPad(device, profile).motor, true); assert.equal(mapPad(high, profile).motor, false);
  profile.arm = { source: 'axis', index: 2, inverted: false };
  assert.match(profileErrors(profile, device).join(), /共用通道/);
  profile.arm = { source: 'button', index: 0, inverted: false };
  assert.equal(mapPad(device, profile).motor, false);
  assert.equal(mapPad({ ...device, buttons: [{ value: 1, pressed: true }] }, profile).motor, true);
  profile.arm.index = 1; assert.match(profileErrors(profile, device).join(), /不存在/);
});

test('legacy calibration migrates without remapping, and arming configuration persists', () => {
  const values = new Map<string, string>();
  const store = new ProfileStore({ getItem: k => values.get(k) ?? null, setItem: (k, v) => { values.set(k, v); } });
  const device = pad({ axes: [0, 0, 0, 0, 0] }), profile = assigned(device);
  profile.channels.roll.center = 0.12; profile.channels.pitch.inverted = true;
  store.save(device, profile);
  for (const [key, json] of values) { const legacy = JSON.parse(json); delete legacy.arm; values.set(key, JSON.stringify(legacy)); }
  assert.deepEqual(store.load(device), profile);
  profile.arm = { source: 'axis', index: 4, inverted: true };
  store.save(device, profile); assert.deepEqual(store.load(device), profile);
});

test('invalid arming input disables the controller and invokes motor-loss handling', () => {
  let device = pad({ axes: [0, 0, 0, 0, 1] }), losses = 0;
  const profile = defaultProfile(device); profile.arm = { source: 'axis', index: 4, inverted: false };
  const controller = new GamepadController(() => [device], message => { losses++; assert.match(message, /电机已关闭/); });
  controller.poll(); controller.enable(device, profile); assert.equal(controller.output.motor, true);
  device = { ...device, axes: [0, 0, 0, 0, NaN] }; controller.poll();
  assert.equal(controller.active, false); assert.equal(losses, 1);
  assert.throws(() => controller.enable(device, profile), /解锁通道输入无效/);
});
