import type { FlightState } from '../physics/simulator.ts';
import type { Parameters } from '../physics/parameters.ts';
import { clamp, rotate, vec, type Vec3 } from '../physics/math.ts';
import { audioChannels, type AudioChannel, type AudioProfile } from './settings.ts';
import { mainStrikeShape, RotorSoundMotion, soundGeometry, soundOperatingPoint, type SoundGeometry, type SoundOperatingPoint, type SoundPose } from './flight-sound.ts';

type Tone = { oscillator: OscillatorNode; gain: GainNode; ratio: number; level: number };
type Band = { name: string; filter: BiquadFilterNode; pulse: GainNode; amount: number; modulation: number; lfo?: OscillatorNode; depth?: GainNode };
type Layer = { output: GainNode; channel: GainNode; highpass?: BiquadFilterNode; tones: Tone[]; bands: Band[] };
type SpatialBus = { gain: GainNode; filter: BiquadFilterNode; panner: PannerNode };
type Burst = { layer: 'main' | 'tail'; source: AudioBufferSourceNode; gain: GainNode; nodes: AudioNode[]; ending: boolean; start: number; rate: number; envelope?: GainNode; duration: number };
const SAMPLE_GAIN = 10.5;
const smoothstep = (a: number, b: number, x: number) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

/** One native Web Audio graph. Continuous voices are allocated once, samples are reused. */
export class HelicopterAudio {
  private ctx?: AudioContext;
  private master?: GainNode;
  private layers?: Record<AudioChannel, Layer>;
  private buses?: Record<'body' | 'main' | 'tail', SpatialBus>;
  private mainBuffer?: AudioBuffer;
  private tailBuffer?: AudioBuffer;
  private samplesPromise?: Promise<void>;
  private loadAbort = new AbortController();
  private targets = new WeakMap<AudioParam, number>();
  private continuous: AudioScheduledSourceNode[] = [];
  private bursts = new Set<Burst>();
  private motion = new RotorSoundMotion();
  private point: SoundOperatingPoint = { rpm: 0, load: 0, pitchLoad: 0, yaw: 0, yawRate: 0, tailDrive: 0, tailRatio: 80 / 19 };
  private geometry?: SoundGeometry;
  private profile: AudioProfile;
  private paused = false;
  private background = false;
  private disposed = false;
  private sleepTimer?: ReturnType<typeof setTimeout>;
  private lastMainCount = 0;
  private lastTailCount = 0;
  private error = '';
  private assetBase: string;

  constructor(profile: AudioProfile, assetBase: string) { this.profile = structuredClone(profile); this.assetBase = assetBase; }
  get diagnostics() {
    return { context: this.ctx?.state ?? 'locked', samplesReady: Boolean(this.mainBuffer && this.tailBuffer), error: this.error,
      activeMain: [...this.bursts].filter(b => b.layer === 'main' && !b.ending).length,
      activeTail: [...this.bursts].filter(b => b.layer === 'tail' && !b.ending).length,
      mainEvents: this.lastMainCount, tailEvents: this.lastTailCount, operatingPoint: { ...this.point }, geometry: this.geometry };
  }
  /** Call directly from a trusted pointer/key handler so resume precedes any network await. */
  async unlock() {
    if (this.disposed || !this.profile.soundEnabled || this.background) return;
    if (!this.ctx) {
      const Constructor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Constructor) { this.error = '当前浏览器不支持音频'; return; }
      this.ctx = new Constructor({ latencyHint: 'interactive' });
      this.build(this.ctx);
    }
    clearTimeout(this.sleepTimer);
    try {
      if (this.ctx.state !== 'running') { await this.ctx.resume(); this.motion.reset(this.point); }
      this.error = ''; this.updateSound();
      if (!this.samplesPromise) this.samplesPromise = this.loadSamples();
      await this.samplesPromise;
      if (this.background || !this.profile.soundEnabled) this.sleep();
    } catch (error) { this.error = error instanceof Error ? error.message : '声音未能启动'; }
  }
  private async loadSamples() {
    const ctx = this.ctx!;
    try {
      const read = async (name: string) => {
        const response = await fetch(`${this.assetBase}${name}`, { signal: this.loadAbort.signal });
        if (!response.ok) throw new Error('爆桨音频加载失败，可重新启用声音重试');
        return ctx.decodeAudioData(await response.arrayBuffer());
      };
      const [main, tail] = await Promise.all([read('main-smack.wav'), read('tail-switch-hybrid.wav')]);
      if (!this.disposed) { this.mainBuffer = main; this.tailBuffer = tail; }
    } catch (error) {
      this.samplesPromise = undefined;
      if (!this.disposed) this.error = error instanceof Error ? error.message : '爆桨音频加载失败';
    }
  }
  setProfile(profile: AudioProfile) {
    const old = this.profile; this.profile = structuredClone(profile);
    for (const layer of ['main', 'tail'] as const) {
      if (!profile.soundEnabled || !profile.enabled[layer] || profile.channelVolumes[layer] === 0 ||
          (layer === 'main' ? !profile.mainTransients : !profile.transients || old.tailVoice !== profile.tailVoice)) this.clearBursts(layer);
    }
    if (old.tailDecay !== profile.tailDecay) for (const b of this.bursts) if (b.layer === 'tail') this.tailRelease(b);
    this.updateSound();
    if (!profile.soundEnabled) this.sleep();
  }
  setPaused(paused: boolean) {
    if (paused === this.paused) return;
    this.paused = paused; this.reset(); this.updateSound();
  }
  setBackground(hidden: boolean) {
    this.background = hidden; this.reset();
    if (hidden) this.sleep();
    else if (this.ctx && this.profile.soundEnabled) void this.unlock();
  }
  reset() { this.motion.reset(this.point); this.clearBursts(); }
  observeFlight(state: FlightState, params: Parameters, dt: number) {
    this.point = soundOperatingPoint(state, params);
    if (!this.ctx || this.ctx.state !== 'running' || this.paused || this.background || !this.profile.soundEnabled) { this.motion.reset(this.point); return; }
    for (const event of this.motion.step(this.point, dt)) {
      if (event.layer === 'main') this.mainStrike(event.rate, event.acceleration);
      else this.tailStrike(event.strength, event.rising);
    }
  }
  /** Camera and aircraft share the interpolated render pose; zoom never changes acoustic distance. */
  render(state: FlightState, params: Parameters, pose: SoundPose, camera: SoundPose) {
    this.point = soundOperatingPoint(state, params);
    const g = this.geometry = soundGeometry(pose, camera.position, state.discRoll, state.discPitch, params, this.profile.mainDirectivity);
    if (!this.ctx || !this.buses) return;
    const listener = this.ctx.listener, forward = rotate(camera.attitude, vec(0, 0, -1)), up = rotate(camera.attitude, vec(0, 1, 0));
    if (listener.positionX) {
      this.position(listener, camera.position);
      for (const [param, value] of [[listener.forwardX, forward.x], [listener.forwardY, forward.y], [listener.forwardZ, forward.z],
        [listener.upX, up.x], [listener.upY, up.y], [listener.upZ, up.z]] as const) this.smooth(param, value, .01);
    } else { listener.setPosition(camera.position.x, camera.position.y, camera.position.z); listener.setOrientation(forward.x, forward.y, forward.z, up.x, up.y, up.z); }
    for (const name of ['body', 'main', 'tail'] as const) {
      const bus = this.buses[name]; this.position(bus.panner, g[name]);
      this.smooth(bus.gain.gain, g.gains[name], .012);
      this.smooth(bus.filter.frequency, Math.min(this.ctx.sampleRate * .45, 18000 / (1 + .01 * Math.max(0, g.distances[name] - 9))), .04);
    }
    this.updateSound();
  }
  private position(node: PannerNode | AudioListener, p: Vec3) {
    this.smooth(node.positionX, p.x, .01); this.smooth(node.positionY, p.y, .01); this.smooth(node.positionZ, p.z, .01);
  }
  private smooth(param: AudioParam, value: number, tau = .055) {
    if (this.targets.get(param) === value) return;
    this.targets.set(param, value); param.setTargetAtTime(value, this.ctx!.currentTime, tau);
  }
  private build(ctx: AudioContext) {
    this.master = ctx.createGain(); this.master.gain.value = 0;
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -12; compressor.knee.value = 12; compressor.ratio.value = 5;
    const headroom = ctx.createGain(); headroom.gain.value = .72;
    const guardInput = ctx.createGain(); guardInput.gain.value = .5;
    const guard = ctx.createWaveShaper(), curve = new Float32Array(8193);
    for (let i = 0; i < curve.length; i++) {
      const x = 4 * i / (curve.length - 1) - 2, a = Math.abs(x);
      curve[i] = a <= .8 ? x : Math.sign(x) * (.8 + .16 * Math.tanh((a - .8) / .16));
    }
    guard.curve = curve;
    this.master.connect(compressor); compressor.connect(headroom); headroom.connect(guardInput); guardInput.connect(guard); guard.connect(ctx.destination);
    this.buses = Object.fromEntries(['body', 'main', 'tail'].map(name => {
      const gain = ctx.createGain(), filter = ctx.createBiquadFilter(), panner = ctx.createPanner();
      filter.type = 'lowpass'; filter.frequency.value = Math.min(18000, ctx.sampleRate * .45); filter.Q.value = .5;
      panner.panningModel = 'equalpower'; panner.rolloffFactor = 0; panner.coneInnerAngle = panner.coneOuterAngle = 360;
      // One explicit pressure-distance model, shared with the testable geometry calculation.
      gain.gain.value = 0; gain.connect(filter); filter.connect(panner); panner.connect(this.master!);
      return [name, { gain, filter, panner }];
    })) as Record<'body' | 'main' | 'tail', SpatialBus>;
    this.layers = Object.fromEntries<Layer>(audioChannels.map(name => {
      const output = ctx.createGain(), channel = ctx.createGain(); output.gain.value = 0;
      channel.gain.value = this.profile.channelVolumes[name] / 100;
      channel.connect(this.buses![name === 'main' || name === 'tail' ? name : 'body'].gain);
      let highpass: BiquadFilterNode | undefined;
      if (name === 'gear') { highpass = ctx.createBiquadFilter(); highpass.type = 'highpass'; highpass.Q.value = .707; highpass.frequency.value = 1200; output.connect(highpass); highpass.connect(channel); }
      else output.connect(channel);
      return [name, { output, channel, highpass, tones: [], bands: [] }];
    })) as Record<AudioChannel, Layer>;
    const noise = ctx.createBuffer(1, ctx.sampleRate * 3, ctx.sampleRate), samples = noise.getChannelData(0);
    let mean = 0;
    for (let i = 0; i < samples.length; i++) { samples[i] = Math.random() * 2 - 1; mean += samples[i]; }
    mean /= samples.length; for (let i = 0; i < samples.length; i++) samples[i] -= mean;
    const tone = (name: AudioChannel, ratio: number, level: number) => {
      const l = this.layers![name], oscillator = ctx.createOscillator(), gain = ctx.createGain();
      oscillator.frequency.value = 1; gain.gain.value = level;
      oscillator.connect(gain); gain.connect(l.output); oscillator.start(); this.continuous.push(oscillator);
      l.tones.push({ oscillator, gain, ratio, level });
    };
    const band = (name: AudioChannel, key: string, frequency: number, q: number, amount: number, modulation = 0) => {
      const l = this.layers![name], source = ctx.createBufferSource(), filter = ctx.createBiquadFilter(), pulse = ctx.createGain();
      source.buffer = noise; source.loop = true; filter.type = 'bandpass'; filter.frequency.value = frequency; filter.Q.value = q; pulse.gain.value = amount;
      source.connect(filter); filter.connect(pulse); pulse.connect(l.output); source.start(0, Math.random() * 2.5); this.continuous.push(source);
      const b: Band = { name: key, filter, pulse, amount, modulation };
      if (modulation) {
        b.lfo = ctx.createOscillator(); b.depth = ctx.createGain(); b.lfo.frequency.value = 1; b.depth.gain.value = amount * modulation;
        b.lfo.connect(b.depth); b.depth.connect(pulse.gain); b.lfo.start(); this.continuous.push(b.lfo);
      }
      l.bands.push(b);
    };
    tone('motor', 1, .10); tone('motor', 2, .035); tone('motor', 1 / 7, .055);
    band('motor', 'body', 420, .65, .25, .25); band('motor', 'vents', 1100, .6, .16, .4);
    tone('gear', 1, .085); tone('gear', 2, .018);
    band('gear', 'body', 3500, .85, .72, .10); band('gear', 'teeth', 6000, .8, .50, .16); band('gear', 'grain', 2400, 1.10, .20, .12);
    tone('belt', 1, .065); band('belt', 'belt', 1800, .6, .32);
    for (let h = 1; h <= 10; h++) tone('main', h, .25 / h ** 1.1);
    band('main', 'air', 700, .6, .9, .8);
    for (let h = 1; h <= 7; h++) tone('tail', h, .13 / h ** 1.15);
    band('tail', 'air', 2200, .6, .4, .8); band('tail', 'strain', 3200, .55, .28, .45);
  }
  private setBand(l: Layer, name: string, center: number, level = 1, frequency = 1, depth?: number) {
    const b = l.bands.find(b => b.name === name)!;
    this.smooth(b.filter.frequency, Math.min(this.ctx!.sampleRate * .45, center)); this.smooth(b.pulse.gain, b.amount * level, .04);
    if (b.lfo && b.depth) { this.smooth(b.lfo.frequency, Math.max(.01, frequency)); this.smooth(b.depth.gain, b.amount * level * (depth ?? b.modulation), .04); }
  }
  private updateSound() {
    if (!this.ctx || !this.layers || !this.master) return;
    const s = this.profile, p = this.point, rev = p.rpm / 60, speed = p.rpm / 3000, load = p.load;
    const right = Math.max(0, p.yaw), left = Math.max(0, -p.yaw), dynamics = s.dynamic / 100;
    const tailPitch = 2 ** (s.pitchShift * p.yaw / 12);
    const frequency = { motor: rev * 70, gear: rev * 120, belt: rev * 80, main: rev * 2, tail: rev * p.tailRatio * 2 * tailPitch };
    for (const name of audioChannels) {
      const l = this.layers[name], effort = name === 'main' ? .32 + 1.4 * load : name === 'tail' ? (.35 + .7 * load) * (1 + dynamics * (.18 * right - .08 * left)) : .3 + .8 * load;
      this.smooth(l.channel.gain, s.enabled[name] ? s.channelVolumes[name] / 100 : 0, .025);
      this.smooth(l.output.gain, (p.rpm / 3000) ** 1.25 * effort, .035);
      for (const t of l.tones) this.smooth(t.oscillator.frequency, clamp(frequency[name] * t.ratio, .01, this.ctx.sampleRate * .45));
    }
    this.smooth(this.layers.gear.highpass!.frequency, 650 + 850 * speed);
    this.setBand(this.layers.motor, 'body', 160 + 450 * speed, .7 + .3 * load, rev * 10);
    this.setBand(this.layers.motor, 'vents', 550 + 1050 * speed, .65 + .35 * load, rev * 60);
    this.setBand(this.layers.gear, 'body', 1900 + 2200 * speed + 600 * load, .7 + .5 * load, rev * 6);
    this.setBand(this.layers.gear, 'teeth', 3200 + 3300 * speed + 900 * load, .65 + .55 * load, rev * 12);
    this.setBand(this.layers.gear, 'grain', 1200 + 1800 * speed, .75 + .45 * load, rev * 9);
    this.setBand(this.layers.belt, 'belt', 600 + 1700 * speed);
    const heavy = smoothstep(.22, .90, load) ** 1.6, second = .28 + .72 * heavy, secondDepth = .2 + .6 * heavy;
    this.setBand(this.layers.main, 'air', 300 + 1000 * speed + 1800 * load, (1 + second) / 2, frequency.main, (.8 + second * secondDepth) / (1 + second));
    this.setBand(this.layers.tail, 'air', (900 + 1800 * speed + 1700 * load) * (1 + dynamics * (.10 * left - .06 * right)) * tailPitch,
      1 + dynamics * (.70 * right - .22 * left), frequency.tail, .8 + dynamics * (.08 * right - .10 * left));
    this.setBand(this.layers.tail, 'strain', (1400 + 1900 * speed + 1100 * load) * tailPitch, dynamics * right ** 1.2 * (.25 + .3 * load), frequency.tail, .45);
    for (const t of this.layers.tail.tones) this.smooth(t.gain.gain, t.level * (1 + dynamics * (.15 * left - .06 * right) * (t.ratio - 1) / 6));
    this.smooth(this.master.gain, s.soundEnabled && !this.paused && !this.background ? s.volume / 100 * .32 : 0, .03);
  }
  private canStrike(layer: 'main' | 'tail') {
    return this.ctx?.state === 'running' && !this.paused && !this.background && this.profile.soundEnabled &&
      this.profile.enabled[layer] && this.profile.channelVolumes[layer] > 0 && this.point.rpm >= (layer === 'main' ? 600 : 350);
  }
  private mainStrike(rate: number, acceleration: number) {
    const s = this.profile, { severity, snap } = mainStrikeShape(rate, acceleration);
    if (!this.canStrike('main') || !this.mainBuffer || !s.mainTransients || !s.mainImpact || severity < .045) return;
    const color = this.ctx!.createBiquadFilter(); color.type = 'highshelf'; color.frequency.value = 2200;
    color.gain.value = (s.mainCrisp - 50) * .04 + 1.4 * (snap - .5);
    this.playBurst('main', this.mainBuffer, clamp((this.point.rpm / 1940) ** .45, .75, 1.35), SAMPLE_GAIN * severity ** .65 * s.mainImpact / 100, [color]);
    this.lastMainCount++;
  }
  private tailStrike(strength: number, rising: boolean) {
    const s = this.profile, buffer = s.tailVoice === 'hybrid' ? this.tailBuffer : this.mainBuffer;
    if (!this.canStrike('tail') || !buffer || !s.transients || !s.impact || strength < .025) return;
    const highpass = this.ctx!.createBiquadFilter(), color = this.ctx!.createBiquadFilter();
    highpass.type = 'highpass'; highpass.frequency.value = 220; highpass.Q.value = .6;
    color.type = 'highshelf'; color.frequency.value = 2200; color.gain.value = 1.2;
    const rate = clamp((this.point.rpm / 1940) ** .45, .75, 1.35) * 2 ** (s.tailBurstPitch / 12);
    this.playBurst('tail', buffer, rate, SAMPLE_GAIN * clamp(strength, 0, 1) * s.impact / 100 * (rising ? 1 : .6), [highpass, color]);
    this.lastTailCount++;
  }
  private playBurst(layer: 'main' | 'tail', buffer: AudioBuffer, rate: number, level: number, nodes: AudioNode[]) {
    const ctx = this.ctx!, source = ctx.createBufferSource(), gain = ctx.createGain(), now = ctx.currentTime;
    source.buffer = buffer; source.playbackRate.value = rate; gain.gain.value = level;
    const envelope = layer === 'tail' ? ctx.createGain() : undefined;
    if (envelope) nodes.push(envelope);
    let end: AudioNode = source; for (const node of nodes) { end.connect(node); end = node; }
    end.connect(gain); gain.connect(this.layers![layer].output);
    const alive = [...this.bursts].filter(b => b.layer === layer && !b.ending);
    if (alive.length >= 4) this.endBurst(alive[0]);
    const burst: Burst = { layer, source, gain, nodes, envelope, start: now, rate, duration: buffer.duration / rate, ending: false };
    this.bursts.add(burst);
    source.onended = () => this.releaseBurst(burst);
    source.start(now); if (envelope) this.tailRelease(burst);
  }
  private tailRelease(b: Burst) {
    if (!b.envelope || b.ending) return;
    const now = this.ctx!.currentTime, duration = Math.min(this.profile.tailDecay, b.source.buffer!.duration / b.rate);
    const end = Math.max(b.start + duration, now + .030), keep = b.start + Math.min(.035, duration * .25), param = b.envelope.gain;
    this.hold(param, now);
    if (now <= keep) { param.setValueAtTime(1, now); param.setValueAtTime(1, keep); }
    else param.linearRampToValueAtTime(.001 ** clamp((now + .008 - keep) / Math.max(.001, b.start + duration - .012 - keep), 0, 1), now + .008);
    param.exponentialRampToValueAtTime(.001, end - .012); param.linearRampToValueAtTime(0, end);
    b.duration = duration; b.source.stop(end + .004);
  }
  private hold(param: AudioParam, now: number) {
    if (param.cancelAndHoldAtTime) param.cancelAndHoldAtTime(now);
    else { const value = param.value; param.cancelScheduledValues(now); param.setValueAtTime(value, now); }
  }
  private endBurst(b: Burst) {
    if (b.ending) return; b.ending = true;
    const now = this.ctx!.currentTime; this.hold(b.gain.gain, now); b.gain.gain.linearRampToValueAtTime(0, now + .012);
    try { b.source.stop(now + .015); } catch { /* Already ended. */ }
  }
  private clearBursts(layer?: 'main' | 'tail') { for (const b of this.bursts) if (!layer || layer === b.layer) this.endBurst(b); }
  private releaseBurst(b: Burst) {
    b.source.onended = null; b.source.disconnect(); b.nodes.forEach(n => n.disconnect()); b.gain.disconnect(); this.bursts.delete(b);
  }
  private sleep() {
    this.clearBursts(); this.updateSound(); clearTimeout(this.sleepTimer);
    this.sleepTimer = setTimeout(() => { if (this.ctx?.state === 'running' && (this.background || !this.profile.soundEnabled)) void this.ctx.suspend(); }, 150);
  }
  dispose() {
    this.disposed = true; this.loadAbort.abort(); clearTimeout(this.sleepTimer);
    for (const b of this.bursts) { try { b.source.stop(); } catch { /* Already ended. */ } this.releaseBurst(b); }
    for (const source of this.continuous) { try { source.stop(); } catch { /* Already stopped. */ } source.disconnect(); }
    if (this.ctx) void this.ctx.close();
  }
}
