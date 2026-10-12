import { HelicopterSimulation, defaultInput } from '../src/physics/simulator.ts';
import { deg } from '../src/physics/math.ts';
import { rateCommand } from '../src/physics/rates.ts';
import type { FblAxis, FblProfile } from '../src/physics/fbl.ts';

export const responseAxes = { roll: { axis: 'x', sign: 1 }, pitch: { axis: 'z', sign: -1 }, yaw: { axis: 'y', sign: -1 } } as const;
export function measureResponse(channel: FblAxis, stick = 1, collective = 0.27, rpm = 2100, profile?: FblProfile, dt = 0.004) {
  const sim = new HelicopterSimulation(), input = defaultInput(), { axis, sign } = responseAxes[channel];
  sim.hover(rpm); sim.state.position.y = 100;
  input.motor = true; input.targetRPM = rpm; input.collective = collective;
  if (profile) input.fbl = profile;
  const magnitude = Math.abs(deg(rateCommand(stick, channel === 'yaw' ? input.rates.yaw : input.rates.cyclic, input.rates.expo)));
  function segment(command: number) {
    input[channel] = command;
    const start = deg(sim.state.rates[axis]) * sign;
    const target = deg(rateCommand(command, channel === 'yaw' ? input.rates.yaw : input.rates.cyclic, input.rates.expo));
    const delta = target - start, direction = Math.sign(delta);
    const tolerance = Math.max(1, magnitude * 0.02);
    let t90 = Infinity, settlingMs = 0, overshoot = 0, last = start;
    for (let n = 1; n <= Math.round(0.6 / dt); n++) {
      sim.step(dt, input); last = deg(sim.state.rates[axis]) * sign;
      if ((last - start) * direction >= Math.abs(delta) * 0.9) t90 = Math.min(t90, n * dt * 1000);
      if (Math.abs(last - target) > tolerance) settlingMs = (n + 1) * dt * 1000;
      overshoot = Math.max(overshoot, (last - target) * direction);
    }
    return { t90, settlingMs, overshootPct: overshoot / magnitude * 100, finalError: Math.abs(last - target) };
  }
  const rise = segment(stick), reverse = segment(-stick), stop = segment(0);
  return { channel, stick, collective, rpm, rise, reverse, stop, crashed: sim.state.crashed };
}
