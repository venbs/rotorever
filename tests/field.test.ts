import test from 'node:test';
import assert from 'node:assert/strict';
import { field, groundProjection, fieldTextureURLs } from '../src/field.ts';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
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

test('photographic eye and collision plane share the estimated 1.8 m eye height; contact works away from spawn', () => {
  const camera = new GroundCamera();
  camera.track({ x: 0, y: 0, z: 0 });
  assert.equal(camera.camera.position.y - field.groundY, 1.8);
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

test('own-field assets are complete, portable, and within the map download/memory budget', () => {
  const environments = new URL('../public/environments/', import.meta.url);
  for (const id of readdirSync(environments)) {
    const root = new URL(`${id}/`, environments);
    const manifest = JSON.parse(readFileSync(new URL('manifest.json', root), 'utf8'));
    assert.equal(manifest.field.id, id);
    assert.deepEqual(manifest.cubeOrder, ['right', 'left', 'top', 'bottom', 'front', 'back']);
    let total = 0;
    for (const tier of ['preview', 'standard'] as const) {
      const files = manifest.tiers[tier].files;
      assert.equal(files.length, 6);
      const urls = fieldTextureURLs(tier, '/rotorever/');
      assert.deepEqual(urls, fieldTextureURLs(tier, '/rotorever'));
      files.forEach((asset: { file: string; bytes: number; sha256: string }, i: number) => {
        assert.ok(urls[i].startsWith(`/rotorever/environments/${field.id}/`));
        assert.equal(asset.file, `${tier}/${manifest.cubeOrder[i]}.webp`);
        const bytes = readFileSync(new URL(asset.file, root));
        assert.equal(bytes.length, asset.bytes);
        assert.equal(bytes.toString('ascii', 8, 12), 'WEBP');
        assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256);
        total += bytes.length;
      });
      assert.equal(files.reduce((sum: number, asset: { bytes: number }) => sum + asset.bytes, 0), manifest.tiers[tier].bytes);
    }
    // The user-refined grass contains much more detail; keep WebP 92 rather
    // than losing that detail to the original low-resolution map's budget.
    const downloadBudget = id === 'river-meadow-hd' ? 8_000_000 : 5_000_000;
    assert.ok(total < downloadBudget, `${id} exceeds ${downloadBudget} bytes: ${total}`);
    assert.equal(manifest.tiers.standard.gpuBytesRGBA8, 96 * 1024 * 1024);
    assert.equal(manifest.tiers.standard.size, 2048);
    assert.equal(manifest.tiers.standard.quality, 92);
    assert.equal(manifest.processing.generateMipmaps, false);
  }
});

test('HD faces keep their user direction mapping, source provenance and calibrated solar position', () => {
  const config = JSON.parse(readFileSync(new URL('../scripts/maps/river-meadow-hd.json', import.meta.url), 'utf8'));
  const manifest = JSON.parse(readFileSync(new URL('../public/environments/river-meadow-hd/manifest.json', import.meta.url), 'utf8'));
  const mapping: Record<string, string> = { forward: 'left', right: 'front', rear: 'right', left: 'back', up: 'top', down: 'bottom' };
  assert.equal(manifest.source.files.length, 6);
  assert.deepEqual(manifest.source.files.map((asset: { projectFace: string }) => asset.projectFace).sort(), Object.values(mapping).sort());
  for (const asset of manifest.source.files) {
    assert.equal(asset.projectFace, mapping[asset.direction]);
    assert.equal(asset.file, config.sources[asset.direction].file);
    assert.equal(asset.sha256, config.sources[asset.direction].sha256);
    assert.deepEqual(asset.size, [4096, 4096]);
  }
  assert.equal(manifest.processing.seamTreatment, 'none; import test');
  assert.equal(manifest.processing.seamAssessment.edges.length, 12);
  const [u, v] = config.calibration.sunUV;
  const sun = new THREE.Vector3(-(2 * u - 1), 1, 2 * v - 1).normalize();
  const ray = manifest.field.lightRay;
  assert.ok(sun.distanceTo(new THREE.Vector3(-ray.x, -ray.y, -ray.z)) < 1e-10);
});

test('spawn looks into the grass and calibrated sun casts toward the front left', () => {
  const manifest = JSON.parse(readFileSync(new URL(`../public/environments/${field.id}/manifest.json`, import.meta.url), 'utf8'));
  const camera = new GroundCamera();
  camera.track({ x: 0, y: .142, z: 0 });
  const direction = camera.camera.getWorldDirection(new THREE.Vector3());
  assert.ok(direction.x > .98 && Math.abs(direction.z) < 1e-10);
  assert.equal(field.backgroundYaw, 0); // Orientation is baked into the tiles.
  const sun = new THREE.Vector3(field.lightRay.x, field.lightRay.y, field.lightRay.z).normalize().negate();
  const elevation = Math.asin(sun.y) * 180 / Math.PI;
  assert.ok(Math.abs(elevation - manifest.processing.calibration.sunElevationDegrees) < 1e-5);
  assert.ok(sun.x < 0 && sun.z > 0); // Behind and right of the initial view.
  const hit = groundProjection({ x: 0, y: 2, z: 0 });
  assert.ok(hit.x > 0 && hit.z < 0);
});

test('generated map preserves source and prompt provenance and derives light from the source sun', () => {
  const config = JSON.parse(readFileSync(new URL('../scripts/maps/river-meadow.json', import.meta.url), 'utf8'));
  const manifest = JSON.parse(readFileSync(new URL('../public/environments/river-meadow/manifest.json', import.meta.url), 'utf8'));
  const source = readFileSync(new URL(`../${config.source}`, import.meta.url));
  const prompt = readFileSync(new URL(`../${config.generation.promptFile}`, import.meta.url));
  assert.equal(createHash('sha256').update(source).digest('hex'), config.sourceSha256);
  assert.equal(config.sourceSha256, manifest.source.sha256);
  assert.equal(createHash('sha256').update(prompt).digest('hex'), config.generation.promptSha256);
  assert.deepEqual(manifest.source.generation, config.generation);
  assert.deepEqual(manifest.source.size, [source.readUInt32BE(16), source.readUInt32BE(20)]);
  const [u, v] = config.calibration.sunUV;
  const azimuth = (u - .5) * Math.PI * 2 - config.calibration.headingDegrees * Math.PI / 180;
  const elevation = (.5 - v) * Math.PI;
  const expected = [-Math.cos(elevation) * Math.cos(azimuth), -Math.sin(elevation), -Math.cos(elevation) * Math.sin(azimuth)];
  const ray = manifest.field.lightRay;
  assert.ok(expected.every((value, i) => Math.abs(value - [ray.x, ray.y, ray.z][i]) < 1e-10));
  assert.equal(manifest.processing.quality.sourcePixelsPer90Degrees, manifest.source.size[0] / 4);
  assert.equal(manifest.processing.quality.standardFacesUpsampled, manifest.source.size[0] < 8192);
  assert.equal(manifest.processing.quality.seamMeanAbsoluteErrorAfter, 0);
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
