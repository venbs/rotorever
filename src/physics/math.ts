/** SI units. Right-handed body frame: X forward, Y up, Z right. */
export type Vec3 = { x: number; y: number; z: number };
export type Quat = { x: number; y: number; z: number; w: number };
export const vec = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
export const add = (a: Vec3, b: Vec3): Vec3 => vec(a.x + b.x, a.y + b.y, a.z + b.z);
export const scale = (v: Vec3, n: number): Vec3 => vec(v.x * n, v.y * n, v.z * n);
export const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
export const norm = (v: Vec3) => Math.hypot(v.x, v.y, v.z);
export const cross = (a: Vec3, b: Vec3): Vec3 => vec(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
export const rad = (v: number) => v * Math.PI / 180;
export const deg = (v: number) => v * 180 / Math.PI;
export const identity = (): Quat => ({ x: 0, y: 0, z: 0, w: 1 });
export const conjugate = (q: Quat): Quat => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });
export const multiply = (a: Quat, b: Quat): Quat => ({
  x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
  y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
  z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
});
export const normalize = (q: Quat): Quat => {
  const n = Math.hypot(q.x, q.y, q.z, q.w);
  return { x: q.x / n, y: q.y / n, z: q.z / n, w: q.w / n };
};
export const rotate = (q: Quat, v: Vec3): Vec3 => {
  const t = scale(cross(q, v), 2);
  return add(v, add(scale(t, q.w), cross(q, t)));
};
export const axisAngle = (axis: Vec3, angle: number): Quat => ({ ...scale(axis, Math.sin(angle / 2)), w: Math.cos(angle / 2) });
/** Exponential-map update, body angular velocity. Normalization prevents drift. */
export const integrateAttitude = (q: Quat, omega: Vec3, dt: number): Quat => {
  const speed = norm(omega);
  if (speed < 1e-12) return { ...q };
  return normalize(multiply(q, axisAngle(scale(omega, 1 / speed), speed * dt)));
};
export const lag = (current: number, target: number, tau: number, dt: number) => current + (target - current) * (1 - Math.exp(-dt / tau));
