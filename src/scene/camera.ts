import { PerspectiveCamera, Vector3 } from 'three';
import { field } from '../field.ts';

export const pilotEye = field.pilot;
export const verticalTrackingTime = 0.1;
// NDC: 0.35 is 17.5% of the full viewport height away from center.
export const maxVerticalScreenOffset = 0.35;

/** Fixed pilot position. Azimuth follows immediately; elevation follows softly
 * so rapid vertical aircraft motion stays visible against a steadier horizon. */
export class GroundCamera {
  readonly camera = new PerspectiveCamera(42, 1, 0.05, 800);
  private target = new Vector3();
  private elevation: number | null = null;
  private previousElevation = 0;
  private azimuth = 0;
  private eye = pilotEye;
  setPilot(eye: typeof pilotEye) { this.eye = eye; this.reset(); }
  track(position: { x: number; y: number; z: number }, dt = 1 / 60) {
    const pilotEye = this.eye;
    this.camera.position.set(pilotEye.x, pilotEye.y, pilotEye.z);
    this.camera.up.set(0, 1, 0);
    const x = position.x - pilotEye.x, y = position.y - pilotEye.y, z = position.z - pilotEye.z;
    const horizontal = Math.hypot(x, z);
    if (!Number.isFinite(horizontal + y) || Math.hypot(horizontal, y) < 1e-6) return;
    // At the zenith the bearing is undefined. Retain the last horizontal heading.
    if (horizontal > 1e-6) this.azimuth = Math.atan2(x, -z);
    const desired = Math.atan2(y, horizontal);
    if (this.elevation === null || !Number.isFinite(dt) || dt > 0.25) this.elevation = desired;
    else if (dt > 0) {
      // Exact one-pole response to the linearly moving target between frames.
      // Using seconds (not a per-frame lerp) keeps 30/60/144 Hz behavior consistent.
      const decay = Math.exp(-dt / verticalTrackingTime);
      const velocity = (desired - this.previousElevation) / dt;
      this.elevation = desired - velocity * verticalTrackingTime
        + (this.elevation - this.previousElevation + velocity * verticalTrackingTime) * decay;
    }
    this.previousElevation = desired;
    const limit = Math.atan(maxVerticalScreenOffset * Math.tan(this.camera.fov * Math.PI / 360));
    // Large climbs, dives and close passes must remain in the central framing.
    this.elevation = Math.max(desired - limit, Math.min(desired + limit, this.elevation));
    const cosElevation = Math.max(1e-8, Math.cos(this.elevation));
    this.target.set(pilotEye.x + Math.sin(this.azimuth) * cosElevation,
      pilotEye.y + Math.sin(this.elevation), pilotEye.z - Math.cos(this.azimuth) * cosElevation);
    this.camera.lookAt(this.target);
  }
  snap(position: { x: number; y: number; z: number }) { this.elevation = null; this.track(position, 0); }
  zoom(delta: number) {
    this.camera.fov = Math.max(20, Math.min(65, this.camera.fov + delta));
    this.camera.updateProjectionMatrix();
  }
  reset() { this.elevation = null; this.camera.fov = 42; this.camera.updateProjectionMatrix(); }
}
