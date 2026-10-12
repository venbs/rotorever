import test from 'node:test';
import assert from 'node:assert/strict';
import { field, groundProjection } from '../src/field.ts';
import { PhotoField } from '../src/scene/photofield.ts';
import { GroundCamera } from '../src/scene/camera.ts';
import { HelicopterSimulation, defaultInput } from '../src/physics/simulator.ts';
import * as THREE from 'three';

test('light-space footprint matches the ground intersection at low, high and distant positions', () => {
  const scene = new THREE.Scene();
  const photo = new PhotoField(scene, { shadowMap: {} } as THREE.WebGLRenderer);
  for (const point of [new THREE.Vector3(0, .142, 0), new THREE.Vector3(5, 2, -8), new THREE.Vector3(-70, 80, 140), new THREE.Vector3(300, 400, -400)]) {
    photo.update(point);
    scene.updateMatrixWorld(true);
    photo.sun.shadow.updateMatrices(photo.sun);
    const hit = groundProjection(point);
    const a = point.clone().applyMatrix4(photo.sun.shadow.matrix);
    const b = new THREE.Vector3(hit.x, hit.y, hit.z).applyMatrix4(photo.sun.shadow.matrix);
    assert.ok(Math.hypot(a.x - b.x, a.y - b.y) < 1e-10);
    for (const uv of [a, b]) assert.ok(uv.x > 0 && uv.x < 1 && uv.y > 0 && uv.y < 1 && uv.z > 0 && uv.z < 1);
    assert.equal(hit.y, field.groundY);
  }
});

test('photographic eye and collision plane share a 1.75 m eye height; contact works away from spawn', () => {
  const camera = new GroundCamera();
  camera.track({ x: 0, y: 0, z: 0 });
  assert.equal(camera.camera.position.y - field.groundY, 1.75);
  for (const [x, z] of [[0, 0], [140, -160], [-800, 620]]) {
    const sim = new HelicopterSimulation(), input = defaultInput();
    sim.state.position.x = x; sim.state.position.z = z;
    for (let i = 0; i < 250; i++) sim.step(.004, input);
    const foot = sim.state.position.y - sim.params.skidHeight;
    assert.equal(sim.state.crashed, false);
    assert.equal(sim.state.grounded, true);
    assert.ok(Math.abs(foot - field.groundY) < .006);
    sim.state.position.y = 0.5; sim.state.velocity.y = -10;
    for (let i = 0; i < 20; i++) sim.step(.004, input);
    assert.equal(sim.state.crashed, true);
  }
});

test('shadow batching preserves transformed silhouette and does not double-transform a moving helicopter', () => {
  const scene = new THREE.Scene(), photo = new PhotoField(scene, { shadowMap: {} } as THREE.WebGLRenderer);
  const helicopter = new THREE.Group(), model = new THREE.Group();
  helicopter.position.set(10, 4, -8); helicopter.rotation.z = .7;
  const body = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)); body.position.set(.3, .2, .1);
  model.add(body); helicopter.add(model); scene.add(helicopter);
  photo.setAircraft(model, helicopter);
  const caster = helicopter.getObjectByName('Batched aircraft shadow') as THREE.Mesh;
  caster.geometry.computeBoundingBox();
  assert.ok(caster.geometry.boundingBox!.getCenter(new THREE.Vector3()).distanceTo(body.position) < 1e-6);
  assert.equal(body.castShadow, false);
  assert.equal(caster.castShadow, true);
  photo.setAircraft(model, helicopter);
  assert.equal(helicopter.children.filter(o => o.name === caster.name).length, 1);
});
