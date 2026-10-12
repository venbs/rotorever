import { clamp, rad } from './math.ts';

/** Conventional cubic Expo, requested by the user. Endpoints stay at full rate. */
export function expoCurve(stick: number, expo: number): number {
  const x = clamp(stick, -1, 1), e = clamp(expo, 0, 0.95);
  return x * (1 - e + e * x * x);
}
export const defaultRates = () => ({ cyclic: 350, yaw: 620, expo: 0.4 });
export type RateProfile = ReturnType<typeof defaultRates>;
export function rateCommand(stick: number, maximumDegrees: number, expo: number): number {
  return rad(maximumDegrees) * expoCurve(stick, expo);
}
