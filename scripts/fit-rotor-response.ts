/** Three positive force derivatives; fit only the first-half low-speed samples.
 * Forward simulation of our actuator + wake. No measured force is fed back.
 * The held-out observations are used only for reporting, never optimization.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { replayRotor } from './recording-rotor-benchmark.ts';
import { parameters } from '../src/physics/parameters.ts';

const [source, destination] = process.argv.slice(2);
if (!source || !destination) throw new Error('Usage: fit-rotor-response.ts reference.json fit.json');
const data = JSON.parse(readFileSync(source, 'utf8'));
const names = ['collectiveGain', 'axialGain', 'inflowGain'] as const;
const bounds = [[1000, 2000], [5, 30], [0, 5]];
const predict = (values: number[]) => {
  const p = structuredClone(parameters);
  names.forEach((key, i) => { p.rotor[key] = values[i]; });
  return replayRotor(data.samples, 3.2, 2100, .002, p).acceleration;
};
const rms = (values: number[], mask: boolean[]) => Math.sqrt(values.reduce((s, y, i) => s + (mask[i] ? (y - data.observed[i]) ** 2 : 0), 0) / mask.filter(Boolean).length);
function solve(a: number[][], b: number[]) {
  const m = a.map((row, i) => [...row, b[i]]);
  for (let k = 0; k < b.length; k++) {
    let pivot = k;
    for (let j = k + 1; j < b.length; j++) if (Math.abs(m[j][k]) > Math.abs(m[pivot][k])) pivot = j;
    [m[k], m[pivot]] = [m[pivot], m[k]];
    if (Math.abs(m[k][k]) < 1e-12) throw new Error('Unidentifiable derivative fit');
    const divisor = m[k][k]; m[k] = m[k].map(v => v / divisor);
    for (let j = 0; j < b.length; j++) if (j !== k) {
      const scale = m[j][k]; m[j] = m[j].map((v, i) => v - scale * m[k][i]);
    }
  }
  return m.map(row => row[b.length]);
}
let values = names.map(key => parameters.rotor[key]), predicted = predict(values);
const history = [];
for (let iteration = 0; iteration < 12; iteration++) {
  const steps = [1, .02, .01];
  const jac = steps.map((step, k) => {
    const trial = [...values]; trial[k] += step;
    return predict(trial).map((y, i) => (y - predicted[i]) / step);
  });
  const a = names.map(() => names.map(() => 0)), b = names.map(() => 0);
  for (let i = 0; i < predicted.length; i++) if (data.train[i]) {
    const error = data.observed[i] - predicted[i];
    for (let j = 0; j < 3; j++) {
      b[j] += jac[j][i] * error;
      for (let k = 0; k < 3; k++) a[j][k] += jac[j][i] * jac[k][i];
    }
  }
  const delta = solve(a, b), before = rms(predicted, data.train);
  let accepted = false;
  for (const scale of [1, .5, .25, .125, .0625]) {
    const next = values.map((v, k) => Math.max(bounds[k][0], Math.min(bounds[k][1], v + scale * delta[k])));
    const y = predict(next), score = rms(y, data.train);
    if (score < before - 1e-7) {
      values = next; predicted = y; accepted = true;
      history.push({ iteration, values, trainRms: score });
      break;
    }
  }
  if (!accepted) break;
}
const result = { conditions: '3.2 kg / 2100 RPM / ±13° reference force scale; max 2 ms substeps. Unknown actual recording mass/RPM.',
  method: 'Bounded three-parameter nonlinear least squares; forward actuator/wake model; first-half low-speed training only.',
  coefficients: Object.fromEntries(names.map((key, i) => [key, values[i]])),
  trainRms: rms(predicted, data.train), heldOutRms: rms(predicted, data.heldOut), freeFlightRms: rms(predicted, data.freeFlight),
  samples: { train: data.train.filter(Boolean).length, heldOut: data.heldOut.filter(Boolean).length }, history };
writeFileSync(destination, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
