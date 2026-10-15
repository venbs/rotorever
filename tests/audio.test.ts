import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultAudioProfile, loadAudioProfile, readAudioProfile, saveAudioProfile } from '../src/audio/settings.ts';
import { distanceGain, mainEdgeGain, mainFacingGain, mainStrikeShape, tailStrikeStrength, RotorSoundMotion, soundGeometry, soundOperatingPoint, type RotorSoundEvent, type SoundOperatingPoint } from '../src/audio/flight-sound.ts';
import { axisAngle, identity, rad, rotate, vec } from '../src/physics/math.ts';
import { parameters } from '../src/physics/parameters.ts';
import { defaultInput, HelicopterSimulation } from '../src/physics/simulator.ts';
import { applyAircraft, defaultAircraft } from '../src/aircraft-settings.ts';

const close = (a: number, b: number, epsilon = 1e-8) => assert.ok(Math.abs(a - b) < epsilon, `${a} ≠ ${b}`);
const point = (pitchLoad = .14, tailDrive = .1, yawRate = 0): SoundOperatingPoint => ({ rpm: 1940, load: Math.sqrt(pitchLoad), pitchLoad, tailDrive, yawRate, yaw: 0, tailRatio: 80 / 19 });

test('pilot-approved v13 calibration is the default and saved settings survive round trips', () => {
  const p = defaultAudioProfile();
  assert.deepEqual(p.channelVolumes, { motor: 130, gear: 40, belt: 130, main: 90, tail: 100 });
  assert.deepEqual([p.volume, p.mainImpact, p.mainCrisp, p.impact, p.tailVoice, p.tailBurstPitch, p.tailDecay], [20, 75, 56, 200, 'hybrid', 0, .6]);
  const values = new Map<string, string>(), storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  p.volume = 36; p.channelVolumes.motor = 0; p.tailDecay = .25;
  assert.equal(saveAudioProfile(storage, p), true); assert.deepEqual(loadAudioProfile(storage), p);
  assert.equal(saveAudioProfile(null, p), false);
  const bad = readAudioProfile({ volume: NaN, impact: 1000, tailDecay: -.2, channelVolumes: { main: 42, motor: Infinity }, enabled: { gear: false } });
  assert.equal(bad.volume, 20); assert.equal(bad.impact, 200); assert.equal(bad.tailDecay, .6); assert.equal(bad.channelVolumes.main, 42); assert.equal(bad.enabled.gear, false);
  p.channelVolumes.main = 2; assert.equal(defaultAudioProfile().channelVolumes.main, 90);
});

test('main disc is loudest face-on from either side and quietest edge-on', () => {
  close(mainFacingGain(vec(0, 1, 0), vec(0, 10, 0)), 1);
  close(mainFacingGain(vec(0, 1, 0), vec(0, -10, 0)), 1);
  close(mainFacingGain(vec(0, 1, 0), vec(10, 0, 0)), mainEdgeGain);
  assert.ok(mainFacingGain(vec(0, 1, 0), vec(5, 5, 0)) > mainEdgeGain);
  close(mainFacingGain(vec(0, 1, 0), vec(10, 0, 0), 0), 1);
  assert.ok(Number.isFinite(mainFacingGain(vec(0, 1, 0), vec())));
});

test('a complete pirouette moves the tail near/far while body distance stays fixed', () => {
  const pose = { position: vec(0, 0, 0), attitude: identity() }, eye = vec(-9, 0, 0);
  const near = soundGeometry(pose, eye, 0, 0, parameters);
  const far = soundGeometry({ ...pose, attitude: axisAngle(vec(0, 1, 0), Math.PI) }, eye, 0, 0, parameters);
  const full = soundGeometry({ ...pose, attitude: axisAngle(vec(0, 1, 0), 2 * Math.PI) }, eye, 0, 0, parameters);
  close(near.distances.body, far.distances.body); close(full.distances.tail, near.distances.tail);
  assert.ok(near.distances.tail < 9 && far.distances.tail > 9);
  assert.ok(near.gains.tail / far.gains.tail > 1.15);
  close(near.mainFacing, far.mainFacing);
});

test('source offsets and main normal follow both aircraft attitude and actual disc tilt', () => {
  const attitude = axisAngle(vec(1, 0, 0), rad(65)), position = vec(5, 8, -2);
  const g = soundGeometry({ position, attitude }, vec(-9, 1.8, 0), .2, -.15, parameters);
  const offset = rotate(attitude, vec(-parameters.tailArm, parameters.tailHeight, .0435));
  close(g.tail.x - position.x, offset.x); close(g.tail.y - position.y, offset.y); close(g.tail.z - position.z, offset.z);
  const local = vec(Math.sin(-.15), 1, Math.sin(.2)), n = Math.hypot(local.x, local.y, local.z);
  const expected = rotate(attitude, vec(local.x / n, local.y / n, local.z / n));
  close(g.normal.x, expected.x); close(g.normal.y, expected.y); close(g.normal.z, expected.z);
  close(distanceGain(9), 1); close(distanceGain(18), .5); assert.ok(Number.isFinite(distanceGain(0)) && distanceGain(0) <= 1.5);
});

test('acoustics use actual RPM and absolute physical blade load, including negative collective', () => {
  const sim = new HelicopterSimulation(); sim.state.rotorSpeed = 1940 * Math.PI / 30; sim.state.collective = rad(6);
  const positive = soundOperatingPoint(sim.state, sim.params); sim.state.collective = -rad(6);
  const negative = soundOperatingPoint(sim.state, sim.params);
  close(positive.rpm, 1940); close(positive.pitchLoad, .5); close(negative.load, positive.load);
  sim.state.rotorSpeed = 0; const stopped = soundOperatingPoint(sim.state, sim.params);
  assert.ok(Object.values(stopped).every(Number.isFinite)); close(stopped.rpm, 0);
});

function gesture(rise: number, count = 1, dt = .004) {
  const m = new RotorSoundMotion(), events: RotorSoundEvent[] = []; m.reset(point());
  const period = rise + .025 + .22 + .1;
  for (let t = 0; t < period * count + .3; t += dt) {
    const phase = t % period;
    let amount = 0;
    if (t < period * count) {
      if (phase < rise) amount = .5 - .5 * Math.cos(Math.PI * phase / rise);
      else if (phase < rise + .025) amount = 1;
      else if (phase < rise + .245) amount = .5 + .5 * Math.cos(Math.PI * (phase - rise - .025) / .22);
    }
    events.push(...m.step(point(.14 + .54 * amount), dt));
  }
  return events.filter(e => e.layer === 'main');
}
test('fast collective pulls trigger once per stroke and holding/slow motion stays quiet', () => {
  assert.equal(gesture(.06).length, 1); assert.equal(gesture(.06, 3).length, 3);
  const motion = new RotorSoundMotion(); motion.reset(point());
  const events: RotorSoundEvent[] = [];
  for (let i = 0; i < 1000; i++) events.push(...motion.step(point(.14 + i / 10000), .004));
  assert.equal(events.length, 0);
  motion.reset(point(.9, 1)); for (let i = 0; i < 100; i++) assert.equal(motion.step(point(.9, 1), .004).length, 0);
  assert.ok(mainStrikeShape(7, 140).severity > mainStrikeShape(1, 10).severity);
});

test('tail servo motion alone never fires a burst while body yaw stays steady', () => {
  const motion = new RotorSoundMotion(); motion.reset(point(.14, -.5, rad(650)));
  const events: RotorSoundEvent[] = [];
  for (let i = 0; i < 250; i++) events.push(...motion.step(point(.14, i % 20 < 10 ? .7 : -.5, rad(650)), .004));
  assert.equal(events.length, 0);
  const stopped = point(.14, .5); stopped.rpm = 100;
  assert.equal(motion.step(stopped, .004).length, 0);
});

function yawManeuver(amplitude: number, ramp: number, dt = .004) {
  const sim = new HelicopterSimulation(), input = defaultInput(); applyAircraft(sim, input, defaultAircraft());
  input.collective = sim.hover(input.targetRPM); sim.state.position.y = 1000; input.motor = true;
  const motion = new RotorSoundMotion(); motion.reset(soundOperatingPoint(sim.state, sim.params));
  const events: { time: number; strength: number; rising: boolean }[] = [];
  for (let t = 0; t < 3.5; t += dt) {
    const target = t < .4 ? 0 : t < 1.4 ? amplitude : t < 2.5 ? -amplitude : 0;
    input.yaw = ramp ? input.yaw + Math.max(-dt / ramp, Math.min(dt / ramp, target - input.yaw)) : target;
    sim.step(dt, input);
    for (const event of motion.step(soundOperatingPoint(sim.state, sim.params), dt)) if (event.layer === 'tail') events.push({ time: t, strength: event.strength, rising: event.rising });
  }
  return events;
}

test('small fast corrections and slow wide tail inputs stay below the explosive threshold', () => {
  for (const amplitude of [.05, .1, .2, -.2]) for (const ramp of [0, .1, .5]) assert.equal(yawManeuver(amplitude, ramp).length, 0, `${amplitude}/${ramp}`);
  assert.equal(yawManeuver(1, .5).length, 0);
});

test('hard tail starts, reversals and stops each fire one acceleration-scaled burst', () => {
  const hard = yawManeuver(1, 0), softer = yawManeuver(1, .1);
  assert.equal(hard.length, 3, JSON.stringify(hard));
  assert.deepEqual(hard.map(e => e.rising), [true, false, true]);
  assert.ok(hard[0].time >= .4 && hard[0].time < .5);
  assert.ok(hard[1].time >= 1.4 && hard[1].time < 1.5);
  assert.ok(hard[2].time >= 2.5 && hard[2].time < 2.6);
  assert.ok(softer.length > 0 && softer[0].strength < hard[0].strength);
  assert.ok(tailStrikeStrength(rad(22000), rad(400)) > tailStrikeStrength(rad(10000), rad(200)));
  assert.equal(tailStrikeStrength(rad(40000), rad(30)), 0, 'high acceleration with negligible speed change is not a heavy maneuver');
  const refined = yawManeuver(1, 0, .002);
  assert.equal(refined.length, hard.length);
  for (let i = 0; i < hard.length; i++) { assert.ok(Math.abs(refined[i].time - hard[i].time) < .015); assert.ok(Math.abs(refined[i].strength - hard[i].strength) < .08); }
  assert.deepEqual(yawManeuver(-1, 0).map(e => e.rising), [false, true, false]);
});

test('collective anti-torque compensation and small high-frequency yaw corrections do not create tail explosions', () => {
  for (const mode of ['collective', 'jitter']) {
    const sim = new HelicopterSimulation(), input = defaultInput(); applyAircraft(sim, input, defaultAircraft());
    const trim = input.collective = sim.hover(input.targetRPM); sim.state.position.y = 1000; input.motor = true;
    const motion = new RotorSoundMotion(); motion.reset(soundOperatingPoint(sim.state, sim.params));
    let tails = 0, mains = 0;
    for (let i = 0; i < 750; i++) {
      const time = i * .004;
      input.collective = mode === 'collective' && time > .3 ? Math.floor((time - .3) / .25) % 2 ? trim : .9 : trim;
      input.yaw = mode === 'jitter' ? .15 * Math.sin(2 * Math.PI * 12 * time) : 0;
      sim.step(.004, input);
      for (const e of motion.step(soundOperatingPoint(sim.state, sim.params), .004)) if (e.layer === 'tail') tails++; else mains++;
    }
    assert.equal(tails, 0, mode);
    if (mode === 'collective') assert.ok(mains > 0, 'main smacking still follows the same hard collective pulls');
  }
});

test('real hover and yaw maneuvers drive sound without changing physics or firing at a steady hover', () => {
  const sim = new HelicopterSimulation(), input = defaultInput(); applyAircraft(sim, input, defaultAircraft());
  input.collective = sim.hover(input.targetRPM); sim.state.position.y = 1000; input.motor = true;
  const motion = new RotorSoundMotion(); motion.reset(soundOperatingPoint(sim.state, sim.params));
  let steady = 0, maneuver = 0;
  for (let i = 0; i < 625; i++) {
    const time = i * .004; input.yaw = time < .6 ? 0 : time < 1.1 ? 1 : time < 1.6 ? -1 : 0;
    sim.step(.004, input);
    const events = motion.step(soundOperatingPoint(sim.state, sim.params), .004);
    if (time < .6) steady += events.length; else maneuver += events.filter(e => e.layer === 'tail').length;
  }
  assert.equal(steady, 0); assert.ok(maneuver >= 2 && maneuver < 10, String(maneuver)); assert.equal(sim.state.crashed, false);
});
