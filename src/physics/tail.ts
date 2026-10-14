import type { Parameters } from './parameters.ts';

const referenceMainSpeed = 2100 * Math.PI / 30;
const referenceTailSpeed = referenceMainSpeed * 80 / 19;

/** Mechanical drive: tail speed follows the main rotor even with the motor off. */
export const tailRotorSpeed = (mainSpeed: number, p: Parameters) => Math.max(0, mainSpeed) * p.tailRatio;

/** Effective blade-pitch authority. Finite at every RPM; zero with a stopped shaft. */
export function tailThrustLimit(mainSpeed: number, p: Parameters) {
  return p.tailMaxForce * p.density / 1.225 * (tailRotorSpeed(mainSpeed, p) / referenceTailSpeed) ** 2;
}

/** Tail power reflected into main-shaft units. It loads the motor/rotor RPM,
 * but is not itself a reaction moment about the main rotor's yaw axis.
 * Uniform induced power + profile losses; no resolved tail wake or blade stall.
 */
export function tailShaftTorque(force: number, mainSpeed: number, p: Parameters) {
  const power = Math.abs(force) ** 1.5 / Math.sqrt(2 * p.density * Math.PI * p.tailRadius ** 2) / 0.72
    + 16 * p.density / 1.225 * (tailRotorSpeed(mainSpeed, p) / referenceTailSpeed) ** 3;
  return power / Math.max(mainSpeed, 20);
}
