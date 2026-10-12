import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { FlightState } from '../physics/simulator.ts';
import { GroundCamera } from './camera.ts';
import { PhotoField } from './photofield.ts';

export type RenderPose = Pick<FlightState, 'position' | 'attitude'>;
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

export class FlightWorld {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly groundCamera = new GroundCamera();
  readonly camera = this.groundCamera.camera;
  readonly helicopter = new THREE.Group();
  vectors = false;
  trailEnabled = false;
  modelLabel = '简易机体';
  private model = new THREE.Group();
  private mainRotor?: THREE.Object3D;
  private tailRotor?: THREE.Object3D;
  private blades: THREE.Object3D[] = [];
  private mainDisc: THREE.Mesh;
  private tailDisc: THREE.Mesh;
  private thrustArrow = new THREE.ArrowHelper(V(0, 1, 0), V(), 1, 0x8abdff, 0.15, 0.07);
  private velocityArrow = new THREE.ArrowHelper(V(1, 0, 0), V(), 1, 0x5fcbef, 0.15, 0.07);
  readonly field: PhotoField;
  private renderPosition = V();
  private renderAttitude = new THREE.Quaternion();
  private trailPoints = new Float32Array(600 * 3);
  private trailGeometry = new THREE.BufferGeometry();
  private trail: THREE.Line;
  private trailCount = 0;
  private trailTime = -1;
  private observer: ResizeObserver;

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.25));
    this.renderer.setClearColor(0x293541);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.domElement.setAttribute('aria-label', '地面固定机位，镜头转向直升机，滚轮调整视野');
    container.appendChild(this.renderer.domElement);
    this.field = new PhotoField(this.scene, this.renderer);

    this.makeFallback();
    this.helicopter.add(this.model);
    this.scene.add(this.helicopter);
    this.field.setAircraft(this.model, this.helicopter);
    const discMaterial = new THREE.MeshBasicMaterial({ color: 0xe1e9e8, side: THREE.DoubleSide, transparent: true, opacity: 0, depthWrite: false });
    this.mainDisc = new THREE.Mesh(new THREE.RingGeometry(0.08, 0.62, 80), discMaterial);
    this.mainDisc.rotation.x = -Math.PI / 2;
    this.mainDisc.position.y = 0.133;
    this.helicopter.add(this.mainDisc);
    this.tailDisc = new THREE.Mesh(new THREE.CircleGeometry(0.105, 40), discMaterial.clone());
    this.tailDisc.position.set(-0.7186, 0, 0.0435);
    this.helicopter.add(this.tailDisc);
    this.scene.add(this.thrustArrow, this.velocityArrow);
    this.trailGeometry.setAttribute('position', new THREE.BufferAttribute(this.trailPoints, 3));
    this.trailGeometry.setDrawRange(0, 0);
    this.trail = new THREE.Line(this.trailGeometry, new THREE.LineBasicMaterial({ color: 0x80b8ff, transparent: true, opacity: 0.65 }));
    this.trail.frustumCulled = false;
    this.scene.add(this.trail);
    this.groundCamera.track({ x: 0, y: 0.3, z: 0 });
    this.renderer.domElement.addEventListener('wheel', event => {
      event.preventDefault();
      this.groundCamera.zoom(Math.sign(event.deltaY) * 2);
    }, { passive: false });
    this.observer = new ResizeObserver(() => {
      const { clientWidth: width, clientHeight: height } = container;
      this.renderer.setSize(width, height);
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
    });
    this.observer.observe(container);
  }

  private makeFallback() {
    const white = new THREE.MeshStandardMaterial({ color: 0xf5f7fa, roughness: 0.35 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x25323a, metalness: 0.4, roughness: 0.45 });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.085, 0.22, 5, 10), white);
    body.rotation.z = Math.PI / 2; body.position.x = 0.08; this.model.add(body);
    const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.024, 0.62, 8), dark);
    boom.rotation.z = Math.PI / 2; boom.position.x = -0.4; this.model.add(boom);
    const rotor = new THREE.Group(); rotor.name = 'MainRotor';
    const blade = new THREE.Mesh(new THREE.BoxGeometry(1.24, 0.005, 0.045), dark);
    blade.name = 'MainBlade'; blade.position.y = 0.133; rotor.add(blade); this.model.add(rotor);
    const tail = new THREE.Group(); tail.name = 'TailRotor'; tail.position.set(-0.7186, 0, 0.0435);
    const tailBlade = new THREE.Mesh(new THREE.BoxGeometry(0.032, 0.21, 0.004), white); tailBlade.name = 'TailBlade'; tail.add(tailBlade); this.model.add(tail);
    for (const z of [-0.078, 0.078]) {
      const skid = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.012, 0.015), dark);
      skid.position.set(0, -0.136, z); this.model.add(skid);
    }
    this.findRotors();
  }
  private findRotors() {
    this.mainRotor = this.model.getObjectByName('MainRotor');
    this.tailRotor = this.model.getObjectByName('TailRotor');
    this.blades = [];
    this.model.traverse(o => { if (/^(MainBlade|TailBlade)/.test(o.name)) this.blades.push(o); });
  }
  async loadModel() {
    try {
      const gltf = await new GLTFLoader().loadAsync('/models/tron550.glb');
      gltf.scene.traverse(o => {
        if (o instanceof THREE.Mesh) {
          o.castShadow = false; o.receiveShadow = false;
          // Clone only the shell's material: white canopy, original mechanics.
          if (o.name === 'CanopyShell') {
            const material = (Array.isArray(o.material) ? o.material[0] : o.material).clone() as THREE.MeshStandardMaterial;
            material.color.set(0xf5f7fa); material.map = null; material.vertexColors = false;
            material.metalness = 0.12; material.roughness = 0.3; o.material = material;
          }
        }
      });
      this.helicopter.remove(this.model);
      this.model.traverse(o => { if (o instanceof THREE.Mesh) { o.geometry.dispose(); (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose()); } });
      this.model = gltf.scene;
      this.helicopter.add(this.model);
      this.findRotors();
      this.field.setAircraft(this.model, this.helicopter);
      this.modelLabel = '白色头罩机体';
      return true;
    } catch (error) {
      console.warn('Model unavailable; using procedural helicopter.', error);
      return false;
    }
  }

  loadField() { return this.field.load(); }

  resetCamera() { this.groundCamera.reset(); this.groundCamera.track(this.helicopter.position); }
  resetTrail() { this.trailCount = 0; this.trailTime = -1; this.trailGeometry.setDrawRange(0, 0); }

  render(state: FlightState, previous: RenderPose, alpha: number) {
    const position = this.helicopter.position;
    position.set(previous.position.x, previous.position.y, previous.position.z).lerp(this.renderPosition.set(state.position.x, state.position.y, state.position.z), alpha);
    this.helicopter.quaternion.set(previous.attitude.x, previous.attitude.y, previous.attitude.z, previous.attitude.w)
      .slerp(this.renderAttitude.set(state.attitude.x, state.attitude.y, state.attitude.z, state.attitude.w), alpha);
    if (this.mainRotor) this.mainRotor.rotation.y = -state.rotorPhase;
    if (this.tailRotor) this.tailRotor.rotation.z = state.rotorPhase * 80 / 19;
    this.blades.forEach(o => { o.visible = state.rotorSpeed < 75; });
    (this.mainDisc.material as THREE.MeshBasicMaterial).opacity = state.rotorSpeed > 35 ? Math.min(0.14, (state.rotorSpeed - 35) / 1200) : 0;
    (this.tailDisc.material as THREE.MeshBasicMaterial).opacity = state.rotorSpeed > 35 ? 0.13 : 0;

    this.field.update(position);
    const setArrow = (arrow: THREE.ArrowHelper, force: { x: number; y: number; z: number }, factor: number) => {
      const v = V(force.x, force.y, force.z);
      arrow.visible = this.vectors && v.length() > 0.05;
      arrow.position.copy(position);
      arrow.setLength(Math.max(0.1, Math.min(3, v.length() * factor)), 0.15, 0.065);
      if (v.lengthSq() > 0) arrow.setDirection(v.normalize());
    };
    setArrow(this.thrustArrow, state.thrustWorld, 0.035);
    setArrow(this.velocityArrow, state.velocity, 0.3);

    if (this.trailEnabled && state.time - this.trailTime > 0.075) {
      this.trailTime = state.time;
      if (this.trailCount >= 600) { this.trailPoints.copyWithin(0, 3); this.trailCount = 599; }
      this.trailPoints.set([position.x, position.y, position.z], this.trailCount * 3);
      this.trailCount++;
      this.trailGeometry.attributes.position.needsUpdate = true;
      this.trailGeometry.setDrawRange(0, this.trailCount);
    }
    this.trail.visible = this.trailEnabled;
    this.groundCamera.track(position);
    this.renderer.render(this.scene, this.camera);
  }
}
