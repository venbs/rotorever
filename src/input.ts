import { clamp } from './physics/math.ts';
import type { FlightInput } from './physics/simulator.ts';
import type { MappedInput } from './gamepad.ts';

export class FlightControls {
  private held = new Set<string>();
  private stickRoll = 0;
  private stickPitch = 0;
  private stickYaw = 0;
  private input: FlightInput;
  private onChange: () => void;
  private readGamepad: () => MappedInput;
  constructor(input: FlightInput, onChange: () => void, onAction: (code: string) => void, readGamepad: () => MappedInput = () => ({})) {
    this.input = input; this.onChange = onChange;
    this.readGamepad = readGamepad;
    const codes = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyS', 'KeyA', 'KeyD', 'Space', 'KeyC'];
    window.addEventListener('keydown', e => {
      if (document.querySelector('dialog[open]')) return;
      const editing = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement;
      if (editing || e.metaKey || e.ctrlKey || e.altKey || !codes.includes(e.code)) return;
      e.preventDefault();
      this.held.add(e.code);
      if (!e.repeat) onAction(e.code);
    });
    window.addEventListener('keyup', e => this.held.delete(e.code));
    window.addEventListener('blur', () => this.clear());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.clear(); });
    this.bindStick('left-stick', true);
    this.bindStick('right-stick', false);
  }
  clear() {
    this.held.clear(); this.stickRoll = 0; this.stickPitch = 0; this.stickYaw = 0;
    this.input.roll = 0; this.input.pitch = 0; this.input.yaw = 0;
  }
  private bindStick(id: string, left: boolean) {
    const area = document.getElementById(id)!;
    let pointer: number | null = null;
    const move = (e: PointerEvent) => {
      const r = area.getBoundingClientRect();
      const x = clamp((e.clientX - r.left - r.width / 2) / (r.width * 0.39), -1, 1);
      const y = clamp((r.top + r.height / 2 - e.clientY) / (r.height * 0.39), -1, 1);
      if (left) { this.input.collective = y; this.stickYaw = x; this.onChange(); }
      else { this.stickRoll = x; this.stickPitch = y; }
    };
    area.addEventListener('pointerdown', e => {
      if (pointer !== null) return;
      pointer = e.pointerId; area.setPointerCapture(pointer); move(e);
    });
    area.addEventListener('pointermove', e => { if (e.pointerId === pointer) move(e); });
    const release = (e: PointerEvent) => {
      if (e.pointerId !== pointer) return;
      pointer = null;
      if (left) this.stickYaw = 0;
      else { this.stickRoll = 0; this.stickPitch = 0; }
    };
    area.addEventListener('pointerup', release);
    area.addEventListener('pointercancel', release);
    area.addEventListener('lostpointercapture', release);
  }
  update(dt: number) {
    const i = this.input;
    const key = (code: string) => this.held.has(code) ? 1 : 0;
    if (key('KeyW') || key('KeyS')) i.collective = clamp(i.collective + (key('KeyW') - key('KeyS')) * dt * 0.8, -1, 1);
    i.roll = clamp(this.stickRoll + key('ArrowRight') - key('ArrowLeft'), -1, 1);
    i.pitch = clamp(this.stickPitch + key('ArrowUp') - key('ArrowDown'), -1, 1);
    i.yaw = clamp(this.stickYaw + key('KeyD') - key('KeyA'), -1, 1);
    const pad = this.readGamepad();
    if (pad.roll !== undefined) i.roll = pad.roll;
    if (pad.pitch !== undefined) i.pitch = pad.pitch;
    if (pad.yaw !== undefined) i.yaw = pad.yaw;
    if (pad.collective !== undefined) i.collective = pad.collective;
    if (pad.motor !== undefined) i.motor = pad.motor;
  }
  paint() {
    const i = this.input;
    const left = document.querySelector<HTMLElement>('#left-stick .stick-dot')!;
    const right = document.querySelector<HTMLElement>('#right-stick .stick-dot')!;
    left.style.left = `${50 + i.yaw * 39}%`; left.style.top = `${50 - i.collective * 39}%`;
    right.style.left = `${50 + i.roll * 39}%`; right.style.top = `${50 - i.pitch * 39}%`;
  }
}
