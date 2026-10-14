/** Ground start, hot rearm and liftoff regression. No stored pilot settings. */
import { writeFileSync } from 'node:fs';
import { applyAircraft } from '../src/aircraft-settings.ts';
import { benchmarkAircraft } from './benchmark-aircraft.ts';
import { HelicopterSimulation, defaultInput } from '../src/physics/simulator.ts';
import { deg, rotate, vec } from '../src/physics/math.ts';
import { tailThrustLimit } from '../src/physics/tail.ts';

export function startupExperiment(options: {
  motor?: number; mass?: number; rpm?: number; dt?: number; duration?: number;
  settled?: boolean; resetAfterTune?: boolean; rearm?: boolean; takeoff?: boolean;
  Simulation?: typeof HelicopterSimulation;
} = {}) {
  const { motor = 90, mass = 5, rpm = 2400, dt = .002, duration = 8,
    settled = false, resetAfterTune = true, rearm = false, takeoff = false,
    Simulation = HelicopterSimulation } = options;
  const sim = new Simulation(), input = defaultInput(), profile = benchmarkAircraft();
  Object.assign(profile, { mass, rpm, motorTorque: motor });
  applyAircraft(sim, input, profile);
  if (resetAfterTune) sim.reset();
  if (settled) for (let k = 0; k < Math.round(1 / dt); k++) sim.step(dt, input);
  let heading = 0, lastAngle = 0, timeTo95: number | null = null;
  const traces = [];
  for (let k = 0; k < Math.round(duration / dt) && !sim.state.crashed; k++) {
    const time = k * dt;
    input.motor = !(rearm && time >= 5 && time < 5.5);
    input.collective = takeoff && time >= 6 ? .35 : 0;
    const previousSpeed = sim.state.rotorSpeed;
    sim.step(dt, input);
    const s = sim.state, forward = rotate(s.attitude, vec(1, 0, 0)), angle = Math.atan2(forward.z, forward.x);
    heading += Math.atan2(Math.sin(angle - lastAngle), Math.cos(angle - lastAngle)); lastAngle = angle;
    const headspeed = s.rotorSpeed * 30 / Math.PI;
    if (timeTo95 === null && headspeed >= rpm * .95) timeTo95 = time + dt;
    traces.push({ time: time + dt, rpm: headspeed, yaw: deg(s.rates.y), heading: deg(heading),
      mainTorque: s.mainRotorTorque, tailMoment: s.tailForce * sim.params.tailArm,
      tailLimit: tailThrustLimit(previousSpeed, sim.params) * sim.params.tailArm,
      x: s.position.x, y: s.position.y, z: s.position.z, grounded: s.grounded });
  }
  return { motor, mass, rpm, dt, settled, resetAfterTune, rearm, takeoff,
    peakYaw: Math.max(...traces.map(t => Math.abs(t.yaw))),
    maxHeading: Math.max(...traces.map(t => Math.abs(t.heading))),
    peakRPM: Math.max(...traces.map(t => t.rpm)), finalRPM: traces.at(-1)!.rpm,
    timeTo95, crashed: sim.state.crashed, finalHeight: sim.state.position.y, grounded: sim.state.grounded, traces };
}

if (process.argv[1]?.endsWith('startup-benchmark.ts')) {
  const cases = [3.2, 5, 8].flatMap(mass => [50, 90, 100].map(motor => startupExperiment({ motor, mass })));
  console.table(cases.map(({ traces, ...c }) => Object.fromEntries(Object.entries(c).map(([k, v]) => [k, typeof v === 'number' ? +v.toFixed(4) : v]))));
  if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(cases, null, 2) + '\n');
}
