import { defaultInput, HelicopterSimulation } from '../src/physics/simulator.ts';
import { measureResponse } from './response-metrics.ts';

const dt = 1 / 250;
// 0 -> positive -> negative -> zero, each held 600 ms. Settling means remaining
// within max(1°/s, 2% of commanded rate), not just the first crossing of a threshold.
for (const channel of ['roll', 'pitch', 'yaw'] as const) for (const stick of [0.25, 1]) {
  console.log(JSON.stringify(measureResponse(channel, stick)));
}
// A warmed deterministic CPU benchmark: no renderer, DOM or Gamepad driver latency.
const sim = new HelicopterSimulation(), input = defaultInput();
input.collective = sim.hover(); input.motor = true;
for (let i = 0; i < 1000; i++) sim.step(dt, input);
const times: number[] = [];
for (let run = 0; run < 5; run++) {
  const start = performance.now();
  for (let i = 0; i < 10000; i++) sim.step(dt, input);
  times.push((performance.now() - start) / 10000);
}
times.sort((a, b) => a - b);
console.log(JSON.stringify({ physicsStepMedianMs: times[2], physics250HzBudgetMs: times[2] * 250 }));
