import test from 'node:test';
import assert from 'node:assert/strict';
import { collectiveFrequency, cameraFrequency, harmonic } from '../scripts/collective-frequency-benchmark.ts';

test('frequency measurement removes drift and recovers a known harmonic', () => {
  const data = Array.from({ length: 1000 }, (_, i) => ({ time: i / 500, value: 5 + i / 500 * .7 + .03 * Math.cos(2 * Math.PI * 6 * i / 500) }));
  const fit = harmonic(data, 6);
  assert.ok(Math.abs(fit.amplitude - .03) < 1e-10);
  assert.ok(Math.abs(fit.drift - .7) < 1e-10);
});

test('5–6 Hz collective reversals survive the actuator and generate actual vertical motion', () => {
  for (const hz of [5, 6]) for (const wave of ['sine', 'square'] as const) {
    const result = collectiveFrequency({ hz, wave, amplitude: 8 });
    assert.ok(result.pitchAmplitudeRatio > .94, `pitch attenuated at ${hz} Hz / ${wave}`);
    assert.ok(result.pitchLagMs < 12);
    assert.ok(result.accelerationAmplitude > 45);
    assert.ok(result.heightPeakToPeakCm > 6, 'bounce must exist in physics, not be added by the renderer');
    assert.ok(result.minimumRPM > 2300);
    const expected = result.accelerationAmplitude / (2 * Math.PI * hz) ** 2 * 200;
    assert.ok(Math.abs(result.heightPeakToPeakCm / expected - 1) < .03, 'position must follow acceleration integrated twice');
  }
});

test('high-frequency response converges and remains present with the requested aerodynamic tune', () => {
  const base = collectiveFrequency(), fine = collectiveFrequency({ dt: .001 });
  assert.ok(Math.abs(fine.heightPeakToPeakCm / base.heightPeakToPeakCm - 1) < .03);
  for (const config of [{ motor: 100 }, { lift: 120, damping: 130 }]) {
    const result = collectiveFrequency(config);
    assert.ok(result.pitchAmplitudeRatio > .98);
    assert.ok(result.accelerationAmplitude > 24);
    assert.ok(result.heightPeakToPeakCm > 3.4);
  }
});

test('vertical camera damping reveals the same physical bounce that hard centering cancels', () => {
  for (const fps of [30, 60, 144]) {
    const result = cameraFrequency(6, .04, fps);
    assert.ok(result.oldScreenPeakToPeakPx < 1e-8);
    assert.ok(result.newScreenPeakToPeakPx > 7.5 && result.newScreenPeakToPeakPx < 8.5);
    assert.ok(result.cameraMotionRatio < .27, 'the horizon must not chase every rapid vertical twitch');
  }
});
