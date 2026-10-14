import { add, conjugate, cross, rotate, scale, vec, type Quat, type Vec3 } from './math.ts';

export const skidSpring = 2200;
export const skidDamping = 42;
export const skidFriction = .65;
export interface SkidContact { local: Vec3; normalImpulse: number }

/** Tangential sequential impulses against a stationary horizontal ground plane.
 * Each skid may stick only within |Jt| <= mu * Jnormal, otherwise it slides.
 * No attitude/rate lock: the same finite impulses change linear/angular momentum.
 * Normal impulses are supplied by the existing spring/damper contact model.
 */
export function resolveSkidFriction(velocity: Vec3, rates: Vec3, attitude: Quat,
  contacts: SkidContact[], mass: number, inertia: Vec3, friction = skidFriction) {
  let v = { ...velocity }, w = { ...rates };
  const inverse = conjugate(attitude), inverseMass = 1 / mass;
  const prepared = contacts.map(contact => {
    const angularResponse = (axis: Vec3) => {
      const torque = cross(contact.local, rotate(inverse, axis));
      return vec(torque.x / inertia.x, torque.y / inertia.y, torque.z / inertia.z);
    };
    const wx = angularResponse(vec(1, 0, 0)), wz = angularResponse(vec(0, 0, 1));
    const vx = rotate(attitude, cross(wx, contact.local)), vz = rotate(attitude, cross(wz, contact.local));
    const xx = inverseMass + vx.x, zz = inverseMass + vz.z, xz = vz.x;
    return { ...contact, wx, wz, xx, zz, xz, determinant: xx * zz - xz * xz,
      limit: Math.max(0, friction * contact.normalImpulse), x: 0, z: 0 };
  });
  // A tiny four-contact problem, solved only while touching the ground.
  for (let iteration = 0; iteration < 12; iteration++) for (const c of prepared) {
    const slip = add(v, rotate(attitude, cross(w, c.local)));
    let x = c.x + (-c.zz * slip.x + c.xz * slip.z) / c.determinant;
    let z = c.z + (c.xz * slip.x - c.xx * slip.z) / c.determinant;
    const magnitude = Math.hypot(x, z);
    if (magnitude > c.limit) { x *= c.limit / magnitude; z *= c.limit / magnitude; }
    const dx = x - c.x, dz = z - c.z;
    v.x += dx * inverseMass; v.z += dz * inverseMass;
    w = add(w, add(scale(c.wx, dx), scale(c.wz, dz)));
    c.x = x; c.z = z;
  }
  return { velocity: v, rates: w, impulses: prepared.map(c => vec(c.x, 0, c.z)) };
}
