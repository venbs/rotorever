/** One shared coordinate frame for contact, pilot, panorama and sun. Metres. */
export const field = Object.freeze({
  id: 'mva-almere', groundY: 0,
  // Source capture (0, 1.75, 0), start (9, 0, 0); shift start to our origin.
  pilot: Object.freeze({ x: -9, y: 1.75, z: 0 }),
  lightRay: Object.freeze({ x: 7, y: -18.25, z: 7 }),
  backgroundYaw: Math.PI / 2,
});

/** Parallel sunlight intersection with the same plane used by physics. */
export function groundProjection(point: { x: number; y: number; z: number }) {
  const t = (field.groundY - point.y) / field.lightRay.y;
  return { x: point.x + t * field.lightRay.x, y: field.groundY, z: point.z + t * field.lightRay.z };
}
