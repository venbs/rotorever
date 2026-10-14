import test from 'node:test';
import assert from 'node:assert/strict';
import { add, axisAngle, conjugate, cross, dot, identity, norm, rotate, scale, vec } from '../src/physics/math.ts';
import { resolveSkidFriction, skidFriction, type SkidContact } from '../src/physics/ground.ts';

const mass = 5, inertia = vec(.055, .133, .25), dt = .002;
const contacts = (normal = mass * 9.80665): SkidContact[] => [-.15, .15].flatMap(x => [-.078, .078].map(z => ({
  local: vec(x, -.142, z), normalImpulse: normal / 4 * dt,
})));
const close = (a: number, b: number, tolerance = 1e-9) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);

test('static skid friction balances sub-limit external force and yaw torque without prior sliding', () => {
  const v = vec(.5 * dt / mass, 0, -.8 * dt / mass), w = vec(0, .8 * dt / inertia.y, 0);
  const c = contacts(), result = resolveSkidFriction(v, w, identity(), c, mass, inertia);
  for (const contact of c) {
    const slip = add(result.velocity, cross(result.rates, contact.local));
    assert.ok(Math.hypot(slip.x, slip.z) < 1e-9, 'contact must stick tangentially');
  }
  // Roll/pitch normal support is solved separately by the compliant contacts.
  assert.ok(Math.abs(result.rates.y) < 1e-9);
});

test('skids dissipate slip with bounded impulses and conserve the corresponding linear/angular momentum', () => {
  for (const yaw of [0, .4, 1.5]) for (const speed of [.01, 1, 20]) {
    const attitude = axisAngle(vec(0, 1, 0), yaw), v = vec(speed, -.1, speed * .4), w = vec(.1, speed * 2, -.05), c = contacts();
    const result = resolveSkidFriction(v, w, attitude, c, mass, inertia);
    let impulse = vec(), angularImpulse = vec();
    for (let i = 0; i < c.length; i++) {
      assert.ok(norm(result.impulses[i]) <= skidFriction * c[i].normalImpulse + 1e-12);
      impulse = add(impulse, result.impulses[i]);
      angularImpulse = add(angularImpulse, cross(c[i].local, rotate(conjugate(attitude), result.impulses[i])));
    }
    for (const a of ['x', 'y', 'z'] as const) {
      close((result.velocity[a] - v[a]) * mass, impulse[a]);
      close((result.rates[a] - w[a]) * inertia[a], angularImpulse[a]);
    }
    const energy = (linear: typeof v, angular: typeof w) => .5 * mass * dot(linear, linear)
      + .5 * dot(angular, vec(inertia.x * angular.x, inertia.y * angular.y, inertia.z * angular.z));
    assert.ok(energy(result.velocity, result.rates) <= energy(v, w) + 1e-9, 'friction added kinetic energy');
    if (speed >= 1) assert.ok(norm(result.velocity) > .5, 'friction must not glue a sliding aircraft to the ground');
  }
});

test('friction releases as normal load vanishes and has no effect without contact', () => {
  const v = vec(.1, 1, .2), w = vec(0, 1, 0);
  for (const c of [[], contacts(0)]) {
    const result = resolveSkidFriction(v, w, identity(), c, mass, inertia);
    assert.deepEqual(result.velocity, v); assert.deepEqual(result.rates, w);
  }
  const a = resolveSkidFriction(v, w, identity(), contacts(10), mass, inertia);
  const b = resolveSkidFriction(v, w, identity(), contacts(1), mass, inertia);
  assert.ok(norm(add(b.velocity, scale(v, -1))) < norm(add(a.velocity, scale(v, -1))));
});
