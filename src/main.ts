import './style.css';
import { FlightWorld, type RenderPose } from './scene/world.ts';
import { FlightControls } from './input.ts';
import { defaultInput, FixedStepClock, HelicopterSimulation } from './physics/simulator.ts';
import { parameters } from './physics/parameters.ts';
import { deg } from './physics/math.ts';
import { GamepadController, ProfileStore, type ProfileStorage } from './gamepad.ts';
import { GamepadPanel } from './gamepad-panel.ts';
import { AircraftPanel } from './aircraft-panel.ts';
import { applyAircraft, loadAircraft } from './aircraft-settings.ts';

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <main class="flight-view" aria-label="飞行场景">
    <div id="viewport"></div>
    <nav id="flight-menu" class="flight-menu" aria-label="模拟器设置">
      <button id="menu-toggle" class="menu-toggle" aria-label="打开设置菜单" aria-expanded="false" aria-controls="menu-items"><span>MENU</span><svg viewBox="0 0 18 18" aria-hidden="true"><path d="M2 5h14M7 9h9M2 13h14"/></svg></button>
      <div id="menu-items" class="menu-items" hidden>
        <button id="aircraft-settings"><span>机体设置</span><small>01</small></button>
        <button disabled aria-disabled="true" title="暂未开放"><span>飞场设置</span><small>—</small></button>
        <button id="controller-settings"><span>遥控器设置</span><small>02</small></button>
      </div>
    </nav>
    <div id="notice" class="notice" role="status" hidden></div>
    <div class="sticks" aria-label="实时打杆">
      <div class="stick-wrap"><div id="left-stick" class="stick" aria-label="左摇杆：偏航与总距"><i></i><span class="stick-dot"></span></div><span>YAW <b>/</b> COL</span></div>
      <div class="stick-wrap"><div id="right-stick" class="stick" aria-label="右摇杆：横滚与俯仰"><i></i><span class="stick-dot"></span></div><span>ROLL <b>/</b> PIT</span></div>
    </div>
    <section class="telemetry-hud" aria-label="动力遥测">
      <div class="hud-heading"><span id="motor-state">SPOOLING</span><span><b id="rotor-rpm">0</b> <small>RPM</small></span></div>
      <dl><div><dt>主旋翼推力</dt><dd id="thrust">0.0 N</dd></div><div><dt>机体重量</dt><dd id="weight">31.4 N</dd></div><div><dt>诱导速度</dt><dd id="inflow">0.00 m/s</dd></div><div><dt>电机扭矩</dt><dd id="torque">0.00 N·m</dd></div><div><dt>尾桨侧推力</dt><dd id="tail">0.00 N</dd></div></dl>
    </section>
  </main>`;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
let storage: ProfileStorage | null = null;
try { storage = window.localStorage; } catch { /* Settings work without persistence. */ }
const sim = new HelicopterSimulation(parameters);
const input = defaultInput();
const aircraftProfile = loadAircraft(storage);
applyAircraft(sim, input, aircraftProfile);
input.motor = true;
const clock = new FixedStepClock();
const previous: RenderPose = { position: { ...sim.state.position }, attitude: { ...sim.state.attitude } };
function capturePose() { Object.assign(previous.position, sim.state.position); Object.assign(previous.attitude, sim.state.attitude); }
let world: FlightWorld;
try { world = new FlightWorld($('viewport')); }
catch (error) {
  $('viewport').innerHTML = '<div class="webgl-error">无法启动 3D 场景。请开启浏览器硬件加速后刷新。</div>';
  throw error;
}
void world.loadModel();
void world.loadField().then(quality => {
  if (quality === 'unavailable') notify('飞场背景加载失败，请刷新重试。');
});
let noticeTimer = 0;
function notify(message: string) {
  $('notice').textContent = message; $('notice').hidden = false;
  clearTimeout(noticeTimer); noticeTimer = window.setTimeout(() => { $('notice').hidden = true; }, 5000);
}
function resetFlight(motor: boolean) {
  controls.clear(); sim.reset(); input.collective = 0; input.motor = motor;
  capturePose(); clock.reset(); world.resetTrail();
}
const gamepadStore = new ProfileStore(storage);
const gamepad = new GamepadController(() => {
  if (!navigator.getGamepads) throw new Error('Gamepad API unavailable');
  return navigator.getGamepads();
}, message => { resetFlight(false); notify(message); }, gamepadStore);
const controls = new FlightControls(input, () => {}, code => {
  if (code === 'Space' && gamepad.output.motor === undefined) input.motor = !input.motor;
  if (code === 'KeyC') world.resetCamera();
}, () => gamepad.output);

const menu = $('flight-menu'), toggle = $('menu-toggle'), items = $('menu-items');
function showMenu(open: boolean) { items.hidden = !open; toggle.setAttribute('aria-expanded', String(open)); }
menu.addEventListener('mouseenter', () => showMenu(true));
menu.addEventListener('mouseleave', () => { if (!menu.contains(document.activeElement)) showMenu(false); });
toggle.onclick = () => showMenu(true);
menu.addEventListener('focusin', () => showMenu(true));
menu.addEventListener('focusout', e => { if (!menu.contains(e.relatedTarget as Node | null)) showMenu(false); });
menu.addEventListener('keydown', e => { if (e.key === 'Escape') { toggle.focus(); showMenu(false); } });
document.addEventListener('pointerdown', e => { if (!menu.contains(e.target as Node)) showMenu(false); });
function openSettings() { showMenu(false); controls.clear(); }
new AircraftPanel(aircraftProfile, storage, profile => applyAircraft(sim, input, profile), openSettings);
const gamepadPanel = new GamepadPanel(gamepad, gamepadStore, () => {
  openSettings(); input.motor = false; input.collective = 0;
}, () => { controls.clear(); });
$('controller-settings').onclick = () => gamepadPanel.open();

function updateReadouts() {
  const s = sim.state, rpm = s.rotorSpeed * 30 / Math.PI;
  $('rotor-rpm').textContent = String(Math.round(rpm));
  $('motor-state').textContent = input.motor ? rpm < input.targetRPM * 0.9 ? 'SPOOLING' : 'ARMED' : 'DISARMED';
  $('motor-state').classList.toggle('armed', input.motor);
  $('thrust').textContent = `${s.thrust.toFixed(1)} N`;
  $('weight').textContent = `${(sim.params.mass * sim.params.gravity).toFixed(1)} N`;
  $('inflow').textContent = `${s.inflow.toFixed(2)} m/s`;
  $('torque').textContent = `${s.motorTorque.toFixed(2)} N·m`;
  $('tail').textContent = `${s.tailForce.toFixed(2)} N`;
  // Accessible current values without adding another visible overlay.
  $('left-stick').setAttribute('aria-label', `左摇杆：偏航 ${Math.round(input.yaw * 100)}%，总距 ${deg(input.collective * sim.params.rotor.maxPitch).toFixed(1)}°`);
  $('right-stick').setAttribute('aria-label', `右摇杆：横滚 ${Math.round(input.roll * 100)}%，俯仰 ${Math.round(input.pitch * 100)}%`);
}
let last = performance.now(), uiLast = 0;
document.addEventListener('visibilitychange', () => { last = performance.now(); clock.reset(); controls.clear(); });
function frame(now: number) {
  const elapsed = Math.max(0, (now - last) / 1000); last = now;
  gamepad.poll(); gamepadPanel.update(now);
  let alpha = clock.advance(elapsed, dt => {
    if (sim.state.crashed) return;
    if (gamepadPanel.dialog.open) {
      // Calibration can exercise every input, including the arming switch.
      // Keep motors off, but never freeze the physical simulation.
      input.roll = input.pitch = input.yaw = input.collective = 0; input.motor = false;
    } else controls.update(dt);
    capturePose(); sim.step(dt, input);
  });
  if (sim.state.crashed) {
    resetFlight(gamepadPanel.dialog.open ? false : gamepad.output.motor ?? true); alpha = 1;
  }
  controls.paint(); world.render(sim.state, previous, alpha);
  if (now - uiLast > 100) { updateReadouts(); uiLast = now; }
  requestAnimationFrame(frame);
}
updateReadouts(); requestAnimationFrame(frame);
