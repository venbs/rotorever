import { clamp, type Vec3 } from './math.ts';
import { parameters, type Parameters } from './parameters.ts';

export interface RotorLoads { thrust: number; torque: number }

/** Azimuth-averaged blade element loads. Uniform inflow; no resolved wake or blade motion.
 * Tangential blade speed plus translational airspeed and axial through-flow determine AoA.
 * All angles are radians. Negative collective produces negative thrust, not negative RPM.
 */
export function bladeElementLoads(omega: number, pitch: number, inflow: number, air: Vec3, p: Parameters = parameters): RotorLoads {
  const r = p.rotor;
  const dr = (r.radius - r.root) / r.radialStations;
  let thrust = 0, torque = 0;
  for (let i = 0; i < r.radialStations; i++) {
    const radius = r.root + (i + 0.5) * dr;
    for (let j = 0; j < r.azimuthStations; j++) {
      const psi = (j + 0.5) * 2 * Math.PI / r.azimuthStations;
      const tangential = omega * radius - air.x * Math.sin(psi) + air.z * Math.cos(psi);
      const axial = air.y + inflow;
      const speed2 = tangential * tangential + axial * axial;
      const phi = Math.atan2(axial, tangential);
      const alpha = Math.atan2(Math.sin(pitch - phi), Math.cos(pitch - phi));
      // Continuous transition from linear lift to an approximate post-stall flat plate.
      const absAlpha = Math.abs(alpha);
      const linear = clamp(r.liftSlope * alpha, -r.liftLimit, r.liftLimit);
      const blend = clamp((absAlpha - 0.22) / 0.22, 0, 1);
      const cl = linear * (1 - blend) + 1.1 * Math.sin(2 * alpha) * blend;
      const cd = r.profileDrag + 0.018 * cl * cl + 1.25 * Math.sin(alpha) ** 2;
      // Smooth tip-loss approximation; not a calibrated Prandtl correction.
      const tip = 1 - 0.25 * (radius / r.radius) ** 8;
      const dynamic = 0.5 * p.density * speed2 * r.chord * dr * r.blades / r.azimuthStations;
      const lift = dynamic * cl * tip, drag = dynamic * cd;
      thrust += lift * Math.cos(phi) - drag * Math.sin(phi);
      torque += radius * (lift * Math.sin(phi) + drag * Math.cos(phi));
    }
  }
  return { thrust, torque };
}

/** Reduced-order, identified rotor force with an explicit wake state.
 * Force derivatives include the reference rotor's steady aerodynamic response;
 * adding the old full BEM induced-velocity subtraction would count it twice.
 * Density, solidity, RPM and radius scale forces; mass still enters only F=ma.
 * This is a simulator-response calibration, not a certified blade/wake model.
 */
export function rotorLoads(omega: number, pitch: number, inflow: number, air: Vec3, p: Parameters = parameters): RotorLoads {
  const r = p.rotor;
  const speed = Math.max(0, omega), referenceOmega = 2100 * Math.PI / 30;
  const radius = r.radius / .62;
  const solidity = r.blades * r.chord / r.radius / (2 * .048 / .62);
  const density = p.density / 1.225;
  const ratio = speed / referenceOmega;
  // Continuous saturation outside the fitted ±13° operating range.
  const angle = Math.abs(pitch), stallStart = 15 * Math.PI / 180, stallWidth = 10 * Math.PI / 180;
  const effectivePitch = Math.sign(pitch) * (angle <= stallStart ? angle : stallStart + stallWidth * Math.tanh((angle - stallStart) / stallWidth));
  const thrust = density * solidity * (r.collectiveGain * radius ** 4 * ratio ** 2 * effectivePitch
    - radius ** 3 * ratio * (r.axialGain * air.y + r.inflowGain * inflow));
  // Shaft power = useful axial/wake power + blade profile losses. The induced
  // term is signed, retaining windmilling/autorotation rather than clamping it.
  const horizontal2 = air.x * air.x + air.z * air.z;
  const profileTorque = r.blades * p.density * r.chord * (r.radius ** 4 - r.root ** 4) / 8
    * r.profileDrag * (speed ** 2 + 3 * horizontal2 / r.radius ** 2);
  const torque = profileTorque + thrust * (air.y + inflow) / Math.max(speed, 1);
  // The identified flight envelope needs a spinning rotor. Blend to blade
  // elements at very low speed for passive airflow loads and spool-down.
  if (speed >= 40) return { thrust, torque };
  const x = clamp((speed - 5) / 35, 0, 1), blend = x * x * (3 - 2 * x);
  const passive = bladeElementLoads(speed, pitch, inflow, air, p);
  return { thrust: passive.thrust * (1 - blend) + thrust * blend,
    torque: passive.torque * (1 - blend) + torque * blend };
}

/** Regularized momentum-theory equilibrium; not valid for vortex-ring/strong descent. */
export function equilibriumInflow(thrust: number, air: Vec3, p: Parameters = parameters): number {
  const area = Math.PI * p.rotor.radius ** 2;
  const hover = Math.sqrt(Math.abs(thrust) / (2 * p.density * area));
  const horizontal2 = air.x * air.x + air.z * air.z;
  const direction = Math.sign(thrust);
  const axial = air.y * direction;
  let velocity = hover;
  for (let i = 0; i < 12; i++) {
    const through = Math.sqrt(horizontal2 + (axial + velocity) ** 2 + (hover * 0.3) ** 2 + 0.01);
    const estimate = Math.abs(thrust) / (2 * p.density * area * through);
    velocity = 0.65 * velocity + 0.35 * Math.min(estimate, 2.5 * hover);
  }
  return velocity * direction;
}

/** Static hover trim: solve thrust and inflow simultaneously at a fixed RPM. */
export function hoverTrim(omega: number, thrust: number, p: Parameters = parameters) {
  const air = { x: 0, y: 0, z: 0 };
  const inflow = equilibriumInflow(thrust, air, p);
  let low = 0, high = p.rotor.maxPitch;
  for (let i = 0; i < 45; i++) {
    const middle = (low + high) / 2;
    if (rotorLoads(omega, middle, inflow, air, p).thrust < thrust) low = middle;
    else high = middle;
  }
  const pitch = (low + high) / 2;
  return { pitch, inflow, ...rotorLoads(omega, pitch, inflow, air, p) };
}
