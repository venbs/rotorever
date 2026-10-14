import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { GroundCamera, pilotEye, maxVerticalScreenOffset } from '../src/scene/camera.ts';

function target(yaw: number, elevation: number, distance = 15) {
  return new Vector3(pilotEye.x + distance * Math.sin(yaw) * Math.cos(elevation),
    pilotEye.y + distance * Math.sin(elevation), pilotEye.z - distance * Math.cos(yaw) * Math.cos(elevation));
}
function screen(rig: GroundCamera, p: Vector3) { rig.camera.updateMatrixWorld(); return p.clone().project(rig.camera); }

test('horizontal tracking is immediate through wraparound while vertical tracking allows bounded movement', () => {
  const rig = new GroundCamera(); rig.snap(target(3, 0));
  let maxY = 0;
  for (let n = 0; n < 600; n++) {
    const p = target(3 + n * .03, .2 * Math.sin(n / 60 * 4));
    rig.track(p, 1 / 60);
    const projected = screen(rig, p);
    assert.ok(Math.abs(projected.x) < 1e-10);
    assert.ok(Math.abs(projected.y) <= maxVerticalScreenOffset + 1e-10);
    assert.deepEqual(rig.camera.position.toArray(), [pilotEye.x, pilotEye.y, pilotEye.z]);
    maxY = Math.max(maxY, Math.abs(projected.y));
  }
  assert.ok(maxY > .15);
});

test('vertical step settles monotonically without camera spring-back', () => {
  const rig = new GroundCamera(); rig.snap(target(0, 0));
  const p = target(0, .08); let previous = Infinity;
  for (let n = 0; n < 60; n++) {
    rig.track(p, 1 / 60); const offset = screen(rig, p).y;
    assert.ok(offset >= -1e-10 && offset <= previous);
    if (n === 0) assert.ok(offset > .15);
    previous = offset;
  }
  assert.ok(previous < .0001);
});

test('elevation tracking agrees across render rates for a continuous angular ramp', () => {
  const directions = [30, 60, 144].map(fps => {
    const rig = new GroundCamera(); rig.snap(target(0, 0));
    for (let n = 1; n <= fps; n++) rig.track(target(n / fps, .4 * n / fps), 1 / fps);
    return rig.camera.getWorldDirection(new Vector3());
  });
  assert.ok(directions[0].distanceTo(directions[1]) < 1e-10);
  assert.ok(directions[0].distanceTo(directions[2]) < 1e-10);
});

test('zoom, abrupt vertical maneuvers, zenith and pilot-position coincidence remain finite and framed', () => {
  const rig = new GroundCamera(); rig.snap(target(0, 0));
  for (const fov of [20, 42, 65]) {
    rig.camera.fov = fov; rig.camera.updateProjectionMatrix();
    for (const elevation of [-1.5, 1.5, Math.PI / 2, -Math.PI / 2, 0]) {
      const p = target(0, elevation); rig.track(p, 1 / 60);
      const projected = screen(rig, p);
      assert.ok(projected.toArray().every(Number.isFinite));
      assert.ok(Math.abs(projected.y) <= maxVerticalScreenOffset + 1e-6);
    }
  }
  rig.track(pilotEye, 1 / 60);
  assert.ok(rig.camera.quaternion.toArray().every(Number.isFinite));
});

test('crash/reset snap and long-background-frame recovery remove stale vertical lag', () => {
  const rig = new GroundCamera(); rig.snap(target(0, .5));
  const ground = target(.2, -.1);
  rig.snap(ground); assert.ok(Math.abs(screen(rig, ground).y) < 1e-9);
  const sky = target(1, .8);
  rig.track(sky, 2); assert.ok(Math.abs(screen(rig, sky).y) < 1e-9);
  rig.reset(); rig.track(ground); assert.ok(Math.abs(screen(rig, ground).y) < 1e-9);
});
