import { PerspectiveCamera, Vector3 } from 'three';
import { field } from '../field.ts';

export const pilotEye = field.pilot;

/** The pilot may turn their head and zoom, but never moves with the aircraft. */
export class GroundCamera {
  readonly camera = new PerspectiveCamera(42, 1, 0.05, 800);
  private target = new Vector3();
  track(position: { x: number; y: number; z: number }) {
    this.camera.position.set(pilotEye.x, pilotEye.y, pilotEye.z);
    this.camera.up.set(0, 1, 0);
    this.target.set(position.x, position.y, position.z);
    this.camera.lookAt(this.target);
  }
  zoom(delta: number) {
    this.camera.fov = Math.max(20, Math.min(65, this.camera.fov + delta));
    this.camera.updateProjectionMatrix();
  }
  reset() { this.camera.fov = 42; this.camera.updateProjectionMatrix(); }
}
