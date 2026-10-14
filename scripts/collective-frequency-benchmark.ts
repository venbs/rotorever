/** Frequency-domain diagnosis: actual forces/motion, independent of camera.
 * Uses fixed regression conditions; never reads or writes a pilot's tune. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Vector3 } from 'three';
import { HelicopterSimulation, defaultInput } from '../src/physics/simulator.ts';
import { applyAircraft } from '../src/aircraft-settings.ts';
import { benchmarkAircraft } from './benchmark-aircraft.ts';
import { deg } from '../src/physics/math.ts';
import { GroundCamera, pilotEye } from '../src/scene/camera.ts';

/** Fit offset + linear drift + sine + cosine, so climb drift isn't called bounce. */
export function harmonic(samples: { time: number; value: number }[], hz: number) {
  const matrix = Array.from({ length: 4 }, () => Array(5).fill(0));
  for (const s of samples) {
    const row = [1, s.time, Math.sin(2 * Math.PI * hz * s.time), Math.cos(2 * Math.PI * hz * s.time)];
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) matrix[i][j] += row[i] * row[j];
      matrix[i][4] += row[i] * s.value;
    }
  }
  for (let i = 0; i < 4; i++) {
    let pivot = i;
    for (let j = i + 1; j < 4; j++) if (Math.abs(matrix[j][i]) > Math.abs(matrix[pivot][i])) pivot = j;
    [matrix[i], matrix[pivot]] = [matrix[pivot], matrix[i]];
    const divisor = matrix[i][i];
    if (Math.abs(divisor) < 1e-10) throw new Error('Insufficient samples for harmonic fit');
    for (let j = i; j < 5; j++) matrix[i][j] /= divisor;
    for (let k = 0; k < 4; k++) if (k !== i) {
      const factor = matrix[k][i];
      for (let j = i; j < 5; j++) matrix[k][j] -= factor * matrix[i][j];
    }
  }
  return { amplitude: Math.hypot(matrix[2][4], matrix[3][4]),
    phase: Math.atan2(matrix[3][4], matrix[2][4]), drift: matrix[1][4] };
}

export function collectiveFrequency({ hz = 6, amplitude = 4, inputHz = 60, dt = .002,
  wave = 'sine', motor = 90, lift = 100, damping = 100 }:
  { hz?: number; amplitude?: number; inputHz?: number; dt?: number; wave?: 'sine' | 'square'; motor?: number; lift?: number; damping?: number } = {}) {
  const profile = benchmarkAircraft(); profile.motorTorque = motor;
  profile.aerodynamics.liftGain = lift; profile.aerodynamics.axialDamping = damping;
  const sim = new HelicopterSimulation(), input = defaultInput(); applyAircraft(sim, input, profile);
  input.motor = true; const trim = sim.hover(profile.rpm); sim.state.position.y = 100;
  const traces = [];
  for (let n = 0; n < Math.round(4 / dt); n++) {
    // Zero-order hold reproduces render-frame Gamepad sampling, without smoothing.
    const sampleTime = Math.floor((n * dt + 1e-9) * inputHz) / inputHz;
    const cycle = Math.cos(2 * Math.PI * hz * sampleTime);
    const phase = (hz * sampleTime + 1e-9) % 1;
    const square = phase < .25 || phase >= .75 ? 1 : -1;
    input.collective = Math.max(-1, Math.min(1, trim + amplitude / profile.pitch * (wave === 'square' ? square : cycle)));
    sim.step(dt, input);
    const s = sim.state;
    if (s.crashed) throw new Error('Unexpected ground contact / numerical failure');
    traces.push({ time: (n + 1) * dt, command: input.collective * profile.pitch, pitch: deg(s.collective),
      thrust: s.thrust, acceleration: s.acceleration.y, velocity: s.velocity.y, height: s.position.y - 100, rpm: s.rotorSpeed * 30 / Math.PI });
  }
  const settled = traces.filter(t => t.time > 2);
  const fit = (key: 'command' | 'pitch' | 'thrust' | 'acceleration' | 'height') => harmonic(settled.map(t => ({ time: t.time, value: t[key] })), hz);
  const command = fit('command'), pitch = fit('pitch'), acceleration = fit('acceleration'), height = fit('height');
  const phase = pitch.phase - command.phase;
  return { hz, amplitude, inputHz, dt, wave, motor, lift, damping, profile,
    pitchAmplitudeRatio: pitch.amplitude / command.amplitude,
    pitchLagMs: -Math.atan2(Math.sin(phase), Math.cos(phase)) / (2 * Math.PI * hz) * 1000,
    accelerationAmplitude: acceleration.amplitude, heightPeakToPeakCm: 200 * height.amplitude,
    minimumRPM: Math.min(...settled.map(t => t.rpm)), traces };
}

/** Same small vertical movement viewed with old centering versus the new rig.
 * Projection reports pixels at 720p; no aircraft state is altered by either camera. */
export function cameraFrequency(hz = 6, heightAmplitude = .02, fps = 60) {
  const rig = new GroundCamera(); rig.camera.aspect = 16 / 9; rig.camera.updateProjectionMatrix();
  const position = (t: number) => new Vector3(pilotEye.x + 9, pilotEye.y + heightAmplitude * Math.cos(2 * Math.PI * hz * t), pilotEye.z);
  rig.snap(position(0));
  const screen = [], locked = [], direction = [], target = [];
  for (let n = 1; n <= fps * 4; n++) {
    const time = n / fps, p = position(time); rig.track(p, 1 / fps);
    const forward = rig.camera.getWorldDirection(new Vector3());
    if (time > 2) {
      screen.push({ time, value: p.clone().project(rig.camera).y * 360 });
      direction.push({ time, value: Math.asin(forward.y) });
      target.push({ time, value: Math.atan2(p.y - pilotEye.y, 9) });
      const centered = rig.camera.clone(); centered.lookAt(p); centered.updateMatrixWorld();
      locked.push({ time, value: p.clone().project(centered).y * 360 });
    }
  }
  return { hz, fps, heightAmplitude, newScreenPeakToPeakPx: 2 * harmonic(screen, hz).amplitude,
    oldScreenPeakToPeakPx: 2 * harmonic(locked, hz).amplitude,
    cameraMotionRatio: harmonic(direction, hz).amplitude / harmonic(target, hz).amplitude };
}

if (process.argv[1]?.endsWith('collective-frequency-benchmark.ts')) {
  const destination = process.argv[2] ?? 'analysis/collective-frequency/results.json';
  const physics = [2, 5, 6, 8].flatMap(hz => [4, 8].map(amplitude => collectiveFrequency({ hz, amplitude })));
  const square = collectiveFrequency({ wave: 'square', amplitude: 8 });
  const sensitivity = [collectiveFrequency({ motor: 100 }), collectiveFrequency({ lift: 120, damping: 130 }), collectiveFrequency({ inputHz: 500 }), collectiveFrequency({ dt: .001 })];
  const camera = physics.map(p => cameraFrequency(p.hz, p.heightPeakToPeakCm / 200));
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, JSON.stringify({ conditions: '5 kg, 2400 RPM, ±12°, hover-trim ± stated pitch amplitude, 4 s, fit last 2 s with linear drift removed. 500 Hz physics; input held at 60 Hz. No real transmitter or HELI-X 5–6 Hz recording used. Camera: same fitted vertical motion at 9 m, 42° FOV, 720p.', physics, square, sensitivity, camera }, null, 2) + '\n');
  console.table(physics.map(({ hz, amplitude, pitchAmplitudeRatio, pitchLagMs, accelerationAmplitude, heightPeakToPeakCm, minimumRPM }) => ({ hz, amplitude, pitchAmplitudeRatio, pitchLagMs, accelerationAmplitude, heightPeakToPeakCm, minimumRPM })));
  console.table(camera);
  console.log(`Saved ${destination}`);
}
