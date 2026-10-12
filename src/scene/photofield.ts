import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { field } from '../field.ts';

const faces = ['right', 'left', 'top', 'bottom', 'front', 'back'];
const sunRay = new THREE.Vector3(field.lightRay.x, field.lightRay.y, field.lightRay.z).normalize();

/** A photograph supplies all scenery; two triangles supply contact depth/shadow. */
export class PhotoField {
  readonly sun = new THREE.DirectionalLight(0xfffaf1, 2.6);
  quality: 'loading' | 'preview' | 'standard' | 'unavailable' = 'loading';
  private texture?: THREE.CubeTexture;
  private shadowCaster?: THREE.Mesh;
  private receiverMaterial = new THREE.ShadowMaterial({ color: 0x101820, opacity: 0.6, depthWrite: false });
  private scene: THREE.Scene;
  private renderer: THREE.WebGLRenderer;

  constructor(scene: THREE.Scene, renderer: THREE.WebGLRenderer) {
    this.scene = scene;
    this.renderer = renderer;
    scene.fog = null;
    scene.background = new THREE.Color(0xa9c4dc);
    scene.backgroundRotation.y = field.backgroundYaw;
    scene.add(new THREE.HemisphereLight(0xd9e8ff, 0x697746, 2.1));
    scene.add(this.sun, this.sun.target);

    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    // A fixed 3.2 m light-space window tracks the one aircraft, not the field.
    // Ground intersection is on the same light rays even at high altitude.
    const camera = this.sun.shadow.camera;
    camera.left = camera.bottom = -1.6;
    camera.right = camera.top = 1.6;
    camera.near = 0.1; camera.far = 40;
    this.sun.shadow.bias = -0.000015;
    this.sun.shadow.normalBias = 0.001;
    this.sun.shadow.radius = 1.5;

    // Depth-only ground must be drawn BEFORE the aircraft. It clips any geometry
    // below the collision plane, without painting over the photograph.
    const geometry = new THREE.PlaneGeometry(100000, 100000);
    geometry.rotateX(-Math.PI / 2);
    const depth = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ colorWrite: false }));
    depth.position.y = field.groundY;
    depth.renderOrder = -100;
    depth.frustumCulled = false;
    const receiver = new THREE.Mesh(geometry, this.receiverMaterial);
    receiver.position.y = field.groundY;
    receiver.receiveShadow = true;
    receiver.frustumCulled = false;
    scene.add(depth, receiver);
  }

  async load() {
    const loadTier = async (tier: 'preview' | 'standard') => {
      const texture = await new THREE.CubeTextureLoader().loadAsync(
        faces.map(face => `${import.meta.env.BASE_URL}environments/mva-almere/${tier}/${face}.webp`),
      );
      texture.name = `MVA-Almere ${tier}`;
      // sRGB background is displayed without filmic re-tonemapping the photo.
      texture.colorSpace = THREE.SRGBColorSpace;
      if (tier === 'preview') {
        // Reflections use the tiny panorama once, never a full-resolution HDR bake.
        const pmrem = new THREE.PMREMGenerator(this.renderer);
        this.scene.environment = pmrem.fromCubemap(texture).texture;
        this.scene.environmentIntensity = 0.5;
        pmrem.dispose();
      }
      const old = this.texture;
      this.texture = texture;
      this.scene.background = texture;
      this.quality = tier;
      old?.dispose();
    };
    try { await loadTier('preview'); }
    catch { /* A failed preview must not prevent the full field from loading. */ }
    // Let the small panorama paint before starting the larger decode/upload.
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    try { await loadTier('standard'); }
    catch (error) {
      if (!this.texture) this.quality = 'unavailable';
      console.warn('Field texture unavailable; retaining the available background.', error);
    }
    return this.quality;
  }

  /** Batch the exact body silhouette into one depth draw, not 70 mesh draws.
   * Moving blades stay separate and stop casting when the renderer hides them.
   * A spinning translucent disc must never cast an opaque dinner-plate shadow.
   */
  setAircraft(model: THREE.Object3D, helicopter: THREE.Group) {
    if (this.shadowCaster) {
      helicopter.remove(this.shadowCaster);
      this.shadowCaster.geometry.dispose();
      (this.shadowCaster.material as THREE.Material).dispose();
    }
    helicopter.updateWorldMatrix(true, true);
    const inverse = helicopter.matrixWorld.clone().invert();
    const parts: THREE.BufferGeometry[] = [];
    model.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      object.receiveShadow = false;
      object.castShadow = /^(MainBlade|TailBlade)/.test(object.name);
      if (object.castShadow) return;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', object.geometry.getAttribute('position').clone());
      if (object.geometry.index) geometry.setIndex(object.geometry.index.clone());
      geometry.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inverse, object.matrixWorld));
      parts.push(geometry.index ? geometry.toNonIndexed() : geometry);
      if (geometry.index) geometry.dispose();
    });
    const geometry = mergeGeometries(parts);
    parts.forEach(part => part.dispose());
    if (!geometry) return;
    // Three's shadow pass uses the view-camera layers too, so a hidden layer is
    // unsuitable here. This inexpensive color-pass draw writes neither color nor depth.
    const caster = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }));
    caster.name = 'Batched aircraft shadow';
    caster.castShadow = true;
    caster.frustumCulled = false;
    helicopter.add(caster);
    this.shadowCaster = caster;
  }

  update(position: THREE.Vector3) {
    this.sun.target.position.copy(position);
    this.sun.position.copy(position).addScaledVector(sunRay, -10);
    const height = Math.max(0, position.y - field.groundY);
    const depth = 14 + height / -sunRay.y;
    const camera = this.sun.shadow.camera;
    camera.far = Math.max(30, depth);
    camera.updateProjectionMatrix();
    // Approximate sun penumbra; keep a legible body silhouette for judging height.
    this.sun.shadow.radius = Math.min(10, 1.5 + height * 0.4);
  }
}
