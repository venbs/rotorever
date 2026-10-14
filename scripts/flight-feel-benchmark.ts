/** Reproducible local comparisons. Does not read/write any pilot's saved tune. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Vector3 } from 'three';
import { HelicopterSimulation, defaultInput } from '../src/physics/simulator.ts';
import { applyAircraft } from '../src/aircraft-settings.ts';
import { benchmarkAircraft } from './benchmark-aircraft.ts';
import { deg } from '../src/physics/math.ts';
import { GroundCamera, pilotEye } from '../src/scene/camera.ts';

export function collectiveExperiment(legacy = false, increment = 10, motor = 90, dt = .002) {
  const sim = new HelicopterSimulation(), input = defaultInput(), profile = benchmarkAircraft();
  profile.motorTorque = motor;
  if (legacy) { sim.params.motor.loadFeedforward = 0; sim.params.motor.responseTime = .075; }
  applyAircraft(sim, input, profile);
  input.motor = true; input.collective = sim.hover(profile.rpm); sim.state.position.y = 100;
  const trim = input.collective;
  input.collective = Math.min(1, trim + increment / profile.pitch);
  const traces = [];
  let pitch99Ms = Infinity;
  for (let step = 1; step <= Math.round(1 / dt); step++) {
    sim.step(dt, input);
    const s = sim.state;
    if (Math.abs(s.collective / sim.params.rotor.maxPitch - input.collective) < .01 * (input.collective - trim)) pitch99Ms = Math.min(pitch99Ms, step * dt * 1000);
    traces.push({ ms: step * dt * 1000, rpm: s.rotorSpeed * 30 / Math.PI, pitch: deg(s.collective), thrust: s.thrust,
      acceleration: s.acceleration.y, velocity: s.velocity.y, height: s.position.y - 100, torque: s.motorTorque });
  }
  return { legacy, increment, motor, profile, pitch99Ms, minimumRPM: Math.min(...traces.map(t => t.rpm)),
    at100ms: traces[Math.round(.1 / dt) - 1], at500ms: traces[Math.round(.5 / dt) - 1], traces };
}

export function cameraTarget(time: number) {
  const yaw = Math.PI / 2 + .15 * Math.sin(1.5 * time), elevation = .08 * Math.sin(2 * Math.PI * 1.5 * time), distance = 15;
  return new Vector3(pilotEye.x + distance * Math.sin(yaw) * Math.cos(elevation),
    pilotEye.y + distance * Math.sin(elevation), pilotEye.z - distance * Math.cos(yaw) * Math.cos(elevation));
}

/** Compare immediate horizontal tracking and damped elevation against target bearing. */
export function cameraExperiment(fps = 60) {
  const rig = new GroundCamera(); rig.camera.aspect = 16 / 9; rig.camera.updateProjectionMatrix();
  rig.track(cameraTarget(0));
  const previous = rig.camera.getWorldDirection(new Vector3()), previousLocked = previous.clone();
  let expectedTravel = 0, actualTravel = 0, maxScreenOffset = 0;
  const traces = [];
  for (let step = 1; step <= fps * 8; step++) {
    const target = cameraTarget(step / fps), locked = target.clone().sub(rig.camera.position).normalize();
    rig.track(target, 1 / fps);
    const direction = rig.camera.getWorldDirection(new Vector3());
    expectedTravel += previousLocked.angleTo(locked); actualTravel += previous.angleTo(direction);
    const screen = target.clone().project(rig.camera);
    maxScreenOffset = Math.max(maxScreenOffset, Math.abs(screen.x), Math.abs(screen.y));
    traces.push({ time: step / fps, lockedElevation: deg(Math.asin(locked.y)), actualElevation: deg(Math.asin(direction.y)), screenX: screen.x, screenY: screen.y });
    previous.copy(direction); previousLocked.copy(locked);
  }
  return { fps, expectedTravel: deg(expectedTravel), actualTravel: deg(actualTravel),
    maxScreenOffset, finalDirection: previous.toArray(), traces };
}

if (process.argv[1]?.endsWith('flight-feel-benchmark.ts')) {
  const destination = process.argv[2] ?? 'analysis/flight-feel/results.json';
  const result = {
    conditions: 'Fixed regression aircraft: 5 kg, 2400 RPM, ±12°, motor 90%. 500 Hz physics, force-balanced hover at 100 m. Legacy ablation: load FF disabled, 75 ms reference motor response. New: load FF enabled, 25 ms response. Same lift model, mass, servo speed, PID and power limits. No measured hardware/browser latency. Camera: immediate horizontal tracking, 100 ms elevation damping with bounded framing; 8 s prescribed trajectory at 15 m, 42° vertical FOV, 16:9.',
    steps: [1, 4, 10].flatMap(increment => [true, false].map(legacy => collectiveExperiment(legacy, increment))),
    camera: [30, 60, 144].map(cameraExperiment),
  };
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, JSON.stringify(result, null, 2) + '\n');
  console.table(result.steps.map(s => ({ legacy: s.legacy, stepDegrees: s.increment, pitch99Ms: s.pitch99Ms,
    minimumRPM: s.minimumRPM.toFixed(0), acceleration100ms: s.at100ms.acceleration.toFixed(2), velocity500ms: s.at500ms.velocity.toFixed(2) })));
  console.table(result.camera.map(({ fps, expectedTravel, actualTravel, maxScreenOffset }) => ({ fps, expectedTravel, actualTravel, maxScreenOffset })));
  console.log(`Saved ${destination}`);
}
