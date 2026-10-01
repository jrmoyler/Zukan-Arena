import type { ElementKind } from '../types';

/**
 * Zukan Arena audio engine.
 *
 * Every sound is synthesised at runtime with the Web Audio API: there are no
 * audio files. The graph looks like this:
 *
 *   sfx voices ──► sfxBus ───┐                    ┌─► muffle (lowpass)
 *        └──────► sfxSend ─┐ │                    │     ► glue compressor
 *   music layers ► duck ─► musicBus ─► masterIn ──┘     ► limiter ► master ► out
 *        └──────► wetDuck ► musicSend ─┐   ▲
 *                          └──────────►┴► reverb (procedural IR)
 *
 * The music is generative and driven by a lookahead scheduler on AudioContext
 * time. All public methods are silent no-ops until `unlock()` succeeds, and
 * whenever Web Audio is unavailable (SSR, Node, vitest).
 */

// ─── Public types ───────────────────────────────────────────────────────────

export type SfxName =
  | 'uiHover' | 'uiClick' | 'uiConfirm' | 'uiBack' | 'uiError' | 'uiToggle'
  | 'countdownTick' | 'countdownGo' | 'roundWin' | 'roundLose' | 'victory' | 'defeat'
  | 'levelUp' | 'reward' | 'discover'
  | 'dash' | 'hitLight' | 'hitHeavy' | 'crit' | 'shieldBlock' | 'ko' | 'lowHealth' | 'ultReady';

export type MusicTrack = 'menu' | 'battle' | 'none';

export interface AudioMix { master: number; music: number; sfx: number } // each 0..1

export interface SfxOptions { pan?: number; volume?: number; pitch?: number }

// ─── Constants & small utilities ────────────────────────────────────────────

const DEFAULT_MIX: AudioMix = { master: 0.8, music: 0.55, sfx: 0.9 };
const MAX_SFX_VOICES = 24;
const SCHEDULER_INTERVAL_MS = 25;
const SCHEDULE_AHEAD_S = 0.12;
const CROSSFADE_S = 1.5;
const STEPS_PER_BAR = 16;
/** Pan is narrowed so positional cues stay gentle on headphones. */
const PAN_WIDTH = 0.75;
/** Exponential ramps cannot reach zero; this is "inaudible". */
const SILENT = 0.0001;

/** Reverb send per SFX: UI stays dry and close, musical phrases bloom. */
const SFX_REVERB: Record<SfxName, number> = {
  uiHover: 0.05, uiClick: 0.08, uiConfirm: 0.2, uiBack: 0.15, uiError: 0.08, uiToggle: 0.08,
  countdownTick: 0.2, countdownGo: 0.35, roundWin: 0.4, roundLose: 0.4, victory: 0.5, defeat: 0.5,
  levelUp: 0.4, reward: 0.4, discover: 0.5,
  dash: 0.1, hitLight: 0.06, hitHeavy: 0.12, crit: 0.2, shieldBlock: 0.18, ko: 0.4, lowHealth: 0.05, ultReady: 0.35,
};

/** Characteristic pitch of each element, used by the ultimate riser. */
const ELEMENT_ROOT: Record<ElementKind, number> = {
  earth: 55, hydro: 220, gale: 440, plasma: 110, nature: 196, void: 49,
};

const clamp = (value: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, value));
const hz = (midi: number): number => 440 * 2 ** ((midi - 69) / 12);
const rand = (lo: number, hi: number): number => lo + Math.random() * (hi - lo);

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Cyclic, bounds-safe array access (patterns wrap around). */
function at<T>(items: readonly T[], index: number): T {
  const item = items[((Math.floor(index) % items.length) + items.length) % items.length];
  if (item === undefined) throw new RangeError('at(): empty list');
  return item;
}

/** Small deterministic PRNG so musical variation is repeatable. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type AudioContextCtor = new () => AudioContext;

function audioContextCtor(): AudioContextCtor | undefined {
  if (typeof AudioContext !== 'undefined') return AudioContext;
  return (globalThis as typeof globalThis & { webkitAudioContext?: AudioContextCtor }).webkitAudioContext;
}

// ─── Music data ─────────────────────────────────────────────────────────────

const LAYER_NAMES = ['pad', 'perc', 'drums', 'hats', 'bass', 'arp', 'lead', 'bell', 'air'] as const;
type LayerName = (typeof LAYER_NAMES)[number];
type Levels = Record<LayerName, number>;

interface Chord { bass: number; notes: readonly number[] }
interface TrackDef { bpm: number; seed: number; chords: readonly Chord[] }

/** 8-bar progressions (MIDI notes). The second half varies the first. */
const TRACKS: Record<Exclude<MusicTrack, 'none'>, TrackDef> = {
  menu: {
    bpm: 80,
    seed: 7,
    chords: [
      { bass: 38, notes: [50, 57, 66, 69, 73] }, // Dmaj7
      { bass: 35, notes: [47, 54, 62, 69, 73] }, // Bm9
      { bass: 31, notes: [43, 50, 59, 66, 69] }, // Gmaj7
      { bass: 33, notes: [45, 52, 62, 64, 66] }, // A6sus4
      { bass: 30, notes: [42, 57, 62, 66, 73] }, // Dmaj7/F#
      { bass: 28, notes: [40, 47, 55, 62, 66] }, // Em9
      { bass: 31, notes: [43, 50, 59, 61, 66] }, // Gmaj7#11
      { bass: 33, notes: [45, 52, 61, 64, 66] }, // A6
    ],
  },
  battle: {
    bpm: 118,
    seed: 31,
    chords: [
      { bass: 35, notes: [47, 54, 59, 62, 66] }, // Bm
      { bass: 31, notes: [43, 55, 59, 62, 67] }, // G
      { bass: 38, notes: [50, 57, 62, 66, 69] }, // D
      { bass: 33, notes: [45, 57, 61, 64, 69] }, // A
      { bass: 35, notes: [47, 54, 59, 62, 66] }, // Bm
      { bass: 31, notes: [43, 55, 59, 62, 67] }, // G
      { bass: 28, notes: [40, 55, 59, 64, 67] }, // Em
      { bass: 30, notes: [42, 54, 58, 61, 66] }, // F#
    ],
  },
};

/** B minor pentatonic, for the battle lead. */
const LEAD_SCALE = [71, 74, 76, 78, 81, 83, 86] as const;
const BASS_STEPS = [0, 3, 6, 8, 11, 14] as const;
const KICK_VARIANTS = [[10], [6, 10], [3, 10], [10, 14]] as const;

const MENU_LEVELS: Levels = { pad: 1, perc: 0, drums: 0, hats: 0, bass: 1, arp: 0.7, lead: 0, bell: 1, air: 1 };

/** Battle layer gains for a 0..1 intensity. */
function battleLevels(i: number): Levels {
  return {
    pad: 1 - 0.35 * i,
    perc: 1,
    drums: smoothstep(0.2, 0.5, i),
    hats: smoothstep(0.3, 0.55, i),
    bass: smoothstep(0.25, 0.5, i),
    arp: smoothstep(0.6, 0.85, i),
    lead: smoothstep(0.78, 1, i),
    bell: 0,
    air: 0.6 * (1 - i),
  };
}

// ─── Internal types ─────────────────────────────────────────────────────────

/** Bundle of nodes that exists once the context is unlocked. */
interface Graph {
  ctx: AudioContext;
  master: GainNode;
  muffle: BiquadFilterNode;
  sfxBus: GainNode;
  sfxSend: GainNode;
  musicBus: GainNode;
  musicSend: GainNode;
  musicDuck: GainNode;
  musicWetDuck: GainNode;
  noise: AudioBuffer;
}

/** One sound event: owns its nodes and tears itself down when its sources end. */
interface Voice {
  g: Graph;
  out: GainNode;
  nodes: AudioNode[];
  sources: AudioScheduledSourceNode[];
  pending: number;
  pooled: boolean;
}

interface VoiceOptions { pan?: number; volume?: number; send?: number }

interface Envelope {
  gain: number;
  attack?: number;
  hold?: number;
  decay: number;
  /** Exponential attack: a reversed, swelling feel. */
  swell?: boolean;
}

interface ToneSpec extends Envelope {
  t: number;
  freq: number;
  /** Exponential glide target, reached after `glide` seconds (default: whole note). */
  to?: number;
  glide?: number;
  type?: OscillatorType;
  detune?: number;
  dest?: AudioNode;
}

interface NoiseSpec extends Envelope {
  t: number;
  filter: BiquadFilterType;
  freq: number;
  to?: number;
  q?: number;
  dest?: AudioNode;
}

interface FmSpec extends ToneSpec { ratio: number; index: number; indexTo: number }

interface ChordSpec {
  gain: number;
  attack: number;
  hold: number;
  release: number;
  cutoff: number;
  cutoffTo: number;
  type?: OscillatorType;
}

interface MusicSession {
  track: Exclude<MusicTrack, 'none'>;
  out: GainNode;
  wet: GainNode;
  layers: Record<LayerName, GainNode>;
  levels: Levels;
  nodes: AudioNode[];
  stepDur: number;
  step: number;
  nextTime: number;
  /** Infinity while playing; set when fading out. */
  stopAt: number;
  rng: () => number;
  barIntensity: number;
}

// ─── Engine ─────────────────────────────────────────────────────────────────

export class AudioEngine {
  private g: Graph | null = null;
  private mix: AudioMix;
  private paused = false;
  private muffle = 0;
  private intensity = 0;
  private track: MusicTrack = 'none';
  private isUnlocked = false;
  private voices: Voice[] = [];
  private sessions: MusicSession[] = [];
  private schedulerId: ReturnType<typeof setInterval> | null = null;

  constructor(mix?: Partial<AudioMix>) {
    this.mix = { ...DEFAULT_MIX };
    if (mix) this.mergeMix(mix);
  }

  // ── Context lifecycle ────────────────────────────────────────────────────

  /** Create/resume the AudioContext. Must be called from a user gesture; safe to call repeatedly. */
  async unlock(): Promise<void> {
    if (!this.g) {
      const Ctor = audioContextCtor();
      if (!Ctor) return;
      try {
        this.g = this.buildGraph(new Ctor());
      } catch {
        return; // Context creation can fail (e.g. too many contexts); stay silent.
      }
      this.setMuffle(this.muffle);
      if (this.track !== 'none') this.startSession(this.g, this.track);
    }
    const g = this.g;
    try {
      if (this.paused && g.ctx.state === 'running') await g.ctx.suspend();
      else if (!this.paused && g.ctx.state === 'suspended') await g.ctx.resume();
    } catch {
      // Resume rejects outside a user gesture; the next unlock() call retries.
    }
    this.isUnlocked = this.g === g && (g.ctx.state === 'running' || this.paused);
  }

  get unlocked(): boolean {
    return this.isUnlocked && this.g !== null;
  }

  setMix(mix: Partial<AudioMix>): void {
    this.mergeMix(mix);
    const g = this.g;
    if (!g) return;
    const now = g.ctx.currentTime;
    g.master.gain.setTargetAtTime(this.mix.master, now, 0.05);
    for (const node of [g.sfxBus, g.sfxSend]) node.gain.setTargetAtTime(this.mix.sfx, now, 0.05);
    for (const node of [g.musicBus, g.musicSend]) node.gain.setTargetAtTime(this.mix.music, now, 0.05);
  }

  /** Suspend/resume everything (pause menu, tab hidden). */
  setPaused(paused: boolean): void {
    this.paused = paused;
    const g = this.g;
    if (!g || !this.isUnlocked) return;
    void (paused ? g.ctx.suspend() : g.ctx.resume()).catch(() => undefined);
  }

  /** Lowpass "muffle" for pause menus / results (0 = clear, 1 = heavily muffled), smooth. */
  setMuffle(amount: number): void {
    this.muffle = clamp(amount, 0, 1);
    const g = this.g;
    if (!g) return;
    // Exponential mapping so the sweep sounds even: 20 kHz → 320 Hz.
    const cutoff = 20000 * (320 / 20000) ** this.muffle;
    g.muffle.frequency.setTargetAtTime(cutoff, g.ctx.currentTime, 0.12);
  }

  async dispose(): Promise<void> {
    this.stopScheduler();
    const g = this.g;
    this.g = null;
    this.isUnlocked = false;
    this.voices = [];
    this.sessions = [];
    if (!g) return;
    try {
      await g.ctx.close();
    } catch {
      // Already closed.
    }
  }

  private mergeMix(mix: Partial<AudioMix>): void {
    if (mix.master !== undefined) this.mix.master = clamp(mix.master, 0, 1);
    if (mix.music !== undefined) this.mix.music = clamp(mix.music, 0, 1);
    if (mix.sfx !== undefined) this.mix.sfx = clamp(mix.sfx, 0, 1);
  }

  /** The graph, but only while the context is actually running. */
  private ready(): Graph | null {
    const g = this.g;
    return g && g.ctx.state === 'running' ? g : null;
  }

  private buildGraph(ctx: AudioContext): Graph {
    const gain = (value: number): GainNode => {
      const node = ctx.createGain();
      node.gain.value = value;
      return node;
    };

    const muffle = ctx.createBiquadFilter();
    muffle.type = 'lowpass';
    muffle.frequency.value = 20000;
    muffle.Q.value = 0.6;

    // Glue compressor, then a fast high-ratio limiter as a clipping safety net.
    const glue = ctx.createDynamicsCompressor();
    glue.threshold.value = -14;
    glue.knee.value = 8;
    glue.ratio.value = 4;
    glue.attack.value = 0.006;
    glue.release.value = 0.2;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -2;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.1;

    const master = gain(this.mix.master);
    const masterIn = gain(1);
    masterIn.connect(muffle).connect(glue).connect(limiter).connect(master).connect(ctx.destination);

    // Shared hall reverb; the highpass keeps low end out of the tail.
    const reverbIn = ctx.createBiquadFilter();
    reverbIn.type = 'highpass';
    reverbIn.frequency.value = 240;
    const convolver = ctx.createConvolver();
    convolver.buffer = impulseResponse(ctx, 2.6);
    reverbIn.connect(convolver).connect(gain(0.8)).connect(masterIn);

    const sfxBus = gain(this.mix.sfx);
    const sfxSend = gain(this.mix.sfx);
    const musicBus = gain(this.mix.music);
    const musicSend = gain(this.mix.music);
    const musicDuck = gain(1);
    const musicWetDuck = gain(1);
    sfxBus.connect(masterIn);
    sfxSend.connect(reverbIn);
    musicDuck.connect(musicBus).connect(masterIn);
    musicWetDuck.connect(musicSend).connect(reverbIn);

    return { ctx, master, muffle, sfxBus, sfxSend, musicBus, musicSend, musicDuck, musicWetDuck, noise: whiteNoise(ctx) };
  }

  // ── Voice management ─────────────────────────────────────────────────────

  private sfxVoice(g: Graph, opts: VoiceOptions): Voice {
    return this.openVoice(g, g.sfxBus, g.sfxSend, opts, true);
  }

  private musicVoice(g: Graph, layer: GainNode, pan?: number): Voice {
    return this.openVoice(g, layer, null, { pan }, false);
  }

  /**
   * Pooled voices count toward the SFX cap; when it is hit the oldest voice is
   * faded out quickly so bursts of hits never pile up.
   */
  private openVoice(g: Graph, dry: AudioNode, wet: AudioNode | null, opts: VoiceOptions, pooled: boolean): Voice {
    if (pooled && this.voices.length >= MAX_SFX_VOICES) this.stealOldest(g);
    const out = g.ctx.createGain();
    out.gain.value = opts.volume ?? 1;
    const v: Voice = { g, out, nodes: [out], sources: [], pending: 0, pooled };
    let tail: AudioNode = out;
    if (opts.pan !== undefined && opts.pan !== 0) {
      const panner = g.ctx.createStereoPanner();
      panner.pan.value = clamp(opts.pan, -1, 1) * PAN_WIDTH;
      out.connect(panner);
      v.nodes.push(panner);
      tail = panner;
    }
    tail.connect(dry);
    if (wet) {
      const send = this.gain(v, opts.send ?? 0.15);
      tail.connect(send);
      send.connect(wet);
    }
    if (pooled) this.voices.push(v);
    return v;
  }

  private stealOldest(g: Graph): void {
    const oldest = this.voices.shift();
    if (!oldest) return;
    const now = g.ctx.currentTime;
    oldest.out.gain.setTargetAtTime(0, now, 0.01);
    for (const src of oldest.sources) {
      try {
        src.stop(now + 0.05);
      } catch {
        // Source already finished.
      }
    }
  }

  /** Starts a source inside a voice; the voice is torn down when its last source ends. */
  private play(v: Voice, src: AudioScheduledSourceNode, start: number, stop: number, offset = 0): void {
    v.sources.push(src);
    v.pending++;
    src.onended = () => {
      src.disconnect();
      v.pending--;
      if (v.pending === 0) this.closeVoice(v);
    };
    if (src instanceof AudioBufferSourceNode) src.start(start, offset);
    else src.start(start);
    src.stop(stop);
  }

  private closeVoice(v: Voice): void {
    for (const node of v.nodes) node.disconnect();
    if (v.pooled) {
      const index = this.voices.indexOf(v);
      if (index >= 0) this.voices.splice(index, 1);
    }
  }

  // ── Instrument primitives ────────────────────────────────────────────────

  private gain(v: Voice, value: number, dest?: AudioNode): GainNode {
    const node = v.g.ctx.createGain();
    node.gain.value = value;
    if (dest) node.connect(dest);
    v.nodes.push(node);
    return node;
  }

  private filter(v: Voice, type: BiquadFilterType, freq: number, q: number, dest: AudioNode): BiquadFilterNode {
    const node = v.g.ctx.createBiquadFilter();
    node.type = type;
    node.frequency.value = freq;
    node.Q.value = q;
    node.connect(dest);
    v.nodes.push(node);
    return node;
  }

  /** Attack (linear, or exponential when swelling), optional hold, exponential decay. */
  private envelope(param: AudioParam, t: number, env: Envelope): number {
    const peak = Math.max(env.gain, SILENT);
    const attack = Math.max(env.attack ?? 0.003, 0.001);
    const hold = env.hold ?? 0;
    if (env.swell) {
      param.setValueAtTime(SILENT, t);
      param.exponentialRampToValueAtTime(peak, t + attack);
    } else {
      param.setValueAtTime(0, t);
      param.linearRampToValueAtTime(peak, t + attack);
    }
    if (hold > 0) param.setValueAtTime(peak, t + attack + hold);
    const end = t + attack + hold + env.decay;
    param.exponentialRampToValueAtTime(SILENT, end);
    return end;
  }

  private glide(param: AudioParam, t: number, from: number, to: number | undefined, duration: number): void {
    param.setValueAtTime(from, t);
    if (to !== undefined && to !== from) param.exponentialRampToValueAtTime(Math.max(to, 1), t + duration);
  }

  /** Enveloped oscillator with optional pitch glide. Returns the oscillator for modulation. */
  private tone(v: Voice, s: ToneSpec): OscillatorNode {
    const osc = v.g.ctx.createOscillator();
    osc.type = s.type ?? 'sine';
    if (s.detune) osc.detune.value = s.detune;
    const amp = this.gain(v, 0, s.dest ?? v.out);
    osc.connect(amp);
    const end = this.envelope(amp.gain, s.t, s);
    this.glide(osc.frequency, s.t, s.freq, s.to, s.glide ?? end - s.t);
    this.play(v, osc, s.t, end + 0.02);
    return osc;
  }

  /** Filtered white noise with an optional filter sweep. */
  private noise(v: Voice, s: NoiseSpec): void {
    const src = v.g.ctx.createBufferSource();
    src.buffer = v.g.noise;
    src.loop = true;
    const amp = this.gain(v, 0, s.dest ?? v.out);
    const filter = this.filter(v, s.filter, s.freq, s.q ?? 1, amp);
    src.connect(filter);
    const end = this.envelope(amp.gain, s.t, s);
    this.glide(filter.frequency, s.t, s.freq, s.to, end - s.t);
    // Random offset into the cached buffer so repeated hits never sound identical.
    this.play(v, src, s.t, end + 0.02, Math.random() * 1.5);
  }

  /** Two-operator FM: great for zaps, metallic clangs and buzzy tones. */
  private fm(v: Voice, s: FmSpec): void {
    const carrier = this.tone(v, s);
    const end = s.t + (s.attack ?? 0.003) + (s.hold ?? 0) + s.decay;
    const mod = v.g.ctx.createOscillator();
    this.glide(mod.frequency, s.t, s.freq * s.ratio, s.to === undefined ? undefined : s.to * s.ratio, end - s.t);
    const depth = this.gain(v, 0, undefined);
    depth.connect(carrier.frequency);
    depth.gain.setValueAtTime(Math.max(s.index * s.freq * s.ratio, SILENT), s.t);
    depth.gain.exponentialRampToValueAtTime(Math.max(s.indexTo * s.freq * s.ratio, SILENT), end);
    mod.connect(depth);
    this.play(v, mod, s.t, end + 0.02);
  }

  /** Glassy porcelain bell: inharmonic partials that decay faster as they rise. */
  private bell(v: Voice, t: number, freq: number, gain: number, decay: number, dest?: AudioNode): void {
    this.tone(v, { t, freq, gain, decay, dest });
    this.tone(v, { t, freq: freq * 2.01, gain: gain * 0.22, decay: decay * 0.6, dest });
    this.tone(v, { t, freq: freq * 2.76, gain: gain * 0.3, decay: decay * 0.4, detune: 4, dest });
    this.tone(v, { t, freq: freq * 5.4, gain: gain * 0.1, decay: decay * 0.18, dest });
  }

  /** Plucked string: saw + triangle through a closing lowpass. */
  private pluck(v: Voice, t: number, freq: number, gain: number, decay: number, brightness = 6): void {
    const lp = this.filter(v, 'lowpass', freq * brightness, 1.2, v.out);
    this.glide(lp.frequency, t, Math.min(freq * brightness, 16000), freq * 1.3, decay * 0.7);
    this.tone(v, { t, freq, type: 'sawtooth', gain: gain * 0.5, decay, dest: lp });
    this.tone(v, { t, freq, type: 'triangle', gain: gain * 0.7, decay: decay * 1.2, detune: 5, dest: lp });
  }

  /** Detuned-saw chord through a moving lowpass: pads and brass stabs. */
  private chord(v: Voice, t: number, notes: readonly number[], c: ChordSpec): void {
    const lp = this.filter(v, 'lowpass', c.cutoff, 0.7, v.out);
    this.glide(lp.frequency, t, c.cutoff, c.cutoffTo, c.attack + c.hold);
    for (const note of notes) {
      for (const detune of [-7, 7]) {
        this.tone(v, {
          t, freq: hz(note), type: c.type ?? 'sawtooth', detune, gain: c.gain,
          attack: c.attack, hold: c.hold, decay: c.release, dest: lp,
        });
      }
    }
  }

  /** A scatter of tiny filtered noise ticks: crackle, rubble, grit. */
  private crackle(v: Voice, t: number, span: number, count: number, gain: number, filter: BiquadFilterType, freq: number): void {
    for (let i = 0; i < count; i++) {
      this.noise(v, {
        t: t + Math.random() * span, filter, freq: freq * rand(0.7, 1.4), q: 3,
        gain: gain * rand(0.5, 1), decay: rand(0.008, 0.03),
      });
    }
  }

  private kick(v: Voice, t: number, gain: number): void {
    this.tone(v, { t, freq: 150, to: 42, glide: 0.12, gain, decay: 0.38 });
    this.noise(v, { t, filter: 'highpass', freq: 4000, gain: gain * 0.25, decay: 0.012 });
  }

  private snare(v: Voice, t: number, gain: number): void {
    this.noise(v, { t, filter: 'bandpass', freq: 1900, q: 0.8, gain, decay: 0.17 });
    this.noise(v, { t, filter: 'highpass', freq: 6500, gain: gain * 0.35, decay: 0.08 });
    this.tone(v, { t, freq: 210, to: 165, type: 'triangle', gain: gain * 0.6, decay: 0.09 });
  }

  private hat(v: Voice, t: number, gain: number, open = false): void {
    this.noise(v, { t, filter: 'highpass', freq: 8200, q: 0.7, gain, decay: open ? 0.24 : 0.035 });
  }

  private boom(v: Voice, t: number, gain: number, decay: number): void {
    this.tone(v, { t, freq: 95, to: 32, glide: decay * 0.8, gain, decay });
    this.noise(v, { t, filter: 'lowpass', freq: 900, to: 90, gain: gain * 0.4, decay: decay * 0.8 });
  }

  // ── UI, combat & feedback SFX ────────────────────────────────────────────

  sfx(name: SfxName, options: SfxOptions = {}): void {
    const g = this.ready();
    if (!g) return;
    const v = this.sfxVoice(g, { pan: options.pan, volume: clamp(options.volume ?? 1, 0, 2), send: SFX_REVERB[name] });
    this.designSfx(v, name, g.ctx.currentTime + 0.005, options.pitch ?? 1);
  }

  private designSfx(v: Voice, name: SfxName, t: number, p: number): void {
    switch (name) {
      case 'uiHover':
        this.tone(v, { t, freq: 3520 * p, gain: 0.025, decay: 0.05 });
        this.tone(v, { t, freq: 1760 * p, type: 'triangle', gain: 0.012, decay: 0.03 });
        break;
      case 'uiClick':
        this.noise(v, { t, filter: 'bandpass', freq: 4200 * p, q: 6, gain: 0.16, decay: 0.012 });
        this.tone(v, { t, freq: 1760 * p, to: 1480 * p, gain: 0.08, decay: 0.05 });
        this.tone(v, { t, freq: 2637 * p, gain: 0.04, decay: 0.035 });
        break;
      case 'uiConfirm':
        this.noise(v, { t, filter: 'bandpass', freq: 5000, q: 5, gain: 0.08, decay: 0.01 });
        this.bell(v, t, hz(81) * p, 0.1, 0.35);
        this.bell(v, t + 0.07, hz(86) * p, 0.12, 0.6);
        break;
      case 'uiBack':
        this.bell(v, t, hz(83) * p, 0.08, 0.25);
        this.bell(v, t + 0.06, hz(76) * p, 0.08, 0.4);
        break;
      case 'uiError': {
        const lp = this.filter(v, 'lowpass', 1800, 0.7, v.out);
        this.tone(v, { t, freq: hz(57) * p, to: hz(56) * p, type: 'triangle', gain: 0.14, decay: 0.12, dest: lp });
        this.tone(v, { t: t + 0.11, freq: hz(56) * p, to: hz(55) * p, type: 'triangle', gain: 0.12, decay: 0.16, dest: lp });
        break;
      }
      case 'uiToggle':
        this.noise(v, { t, filter: 'bandpass', freq: 3000 * p, q: 5, gain: 0.1, decay: 0.01 });
        this.tone(v, { t, freq: 1175 * p, to: 1568 * p, glide: 0.04, gain: 0.07, decay: 0.06 });
        break;
      case 'countdownTick':
        this.noise(v, { t, filter: 'bandpass', freq: 2500, q: 3, gain: 0.12, decay: 0.02 });
        this.tone(v, { t, freq: 220 * p, gain: 0.14, decay: 0.1 });
        this.bell(v, t, hz(81) * p, 0.15, 0.5);
        break;
      case 'countdownGo':
        this.noise(v, { t, filter: 'bandpass', freq: 800, to: 6000, q: 1.5, gain: 0.12, decay: 0.45 });
        this.boom(v, t, 0.5, 0.6);
        this.chord(v, t, [62, 66, 69, 74], { gain: 0.04, attack: 0.01, hold: 0.25, release: 0.7, cutoff: 3500, cutoffTo: 1200 });
        [74, 78, 81, 86].forEach((n, i) => this.bell(v, t + i * 0.015, hz(n) * p, 0.1, 1.2));
        break;
      case 'roundWin':
        [74, 78, 81, 86].forEach((n, i) => {
          this.bell(v, t + i * 0.09, hz(n) * p, 0.11, i === 3 ? 1.2 : 0.6);
          this.pluck(v, t + i * 0.09, hz(n - 12) * p, 0.08, 0.3);
        });
        break;
      case 'roundLose': {
        const lp = this.filter(v, 'lowpass', 2200, 0.7, v.out);
        [71, 69, 66].forEach((n, i) => this.bell(v, t + i * 0.14, hz(n) * p, 0.1, i === 2 ? 1.1 : 0.5, lp));
        this.tone(v, { t, freq: hz(47) * p, type: 'triangle', gain: 0.08, attack: 0.1, decay: 1.1, dest: lp });
        break;
      }
      case 'victory':
        [74, 78, 81, 86, 90].forEach((n, i) => this.bell(v, t + i * 0.1, hz(n) * p, 0.1, 0.6));
        this.chord(v, t + 0.5, [62, 66, 69, 74], { gain: 0.035, attack: 0.04, hold: 0.6, release: 1.3, cutoff: 900, cutoffTo: 3200 });
        [86, 90, 93].forEach((n) => this.bell(v, t + 0.5, hz(n) * p, 0.07, 1.6));
        this.boom(v, t + 0.5, 0.45, 0.9);
        break;
      case 'defeat': {
        const lp = this.filter(v, 'lowpass', 2000, 0.7, v.out);
        [71, 67, 64, 66].forEach((n, i) => this.bell(v, t + i * 0.22, hz(n) * p, 0.1, i === 3 ? 1.6 : 0.8, lp));
        this.tone(v, { t, freq: hz(35) * p, gain: 0.25, attack: 0.4, swell: true, hold: 0.4, decay: 1.4 });
        break;
      }
      case 'levelUp':
        [74, 76, 78, 81, 83, 86].forEach((n, i) => this.pluck(v, t + i * 0.055, hz(n) * p, 0.1, 0.3, 8));
        this.bell(v, t + 0.28, hz(90) * p, 0.09, 0.9);
        this.bell(v, t + 0.33, hz(93) * p, 0.08, 1.1);
        this.noise(v, { t: t + 0.25, filter: 'highpass', freq: 7000, gain: 0.04, attack: 0.05, decay: 0.6 });
        break;
      case 'reward':
        this.bell(v, t, hz(83) * p, 0.12, 0.5);
        this.bell(v, t + 0.08, hz(88) * p, 0.13, 0.9);
        [98, 102, 105].forEach((n, i) => this.tone(v, { t: t + 0.12 + i * 0.04, freq: hz(n) * p, gain: 0.03, decay: 0.2 }));
        break;
      case 'discover':
        this.noise(v, { t, filter: 'highpass', freq: 5000, to: 9000, gain: 0.04, attack: 0.3, swell: true, decay: 0.6 });
        this.tone(v, { t, freq: hz(55) * p, gain: 0.08, attack: 0.3, hold: 0.3, decay: 1 });
        this.tone(v, { t, freq: hz(62) * p, gain: 0.06, attack: 0.3, hold: 0.3, decay: 1 });
        [67, 71, 74, 78, 81].forEach((n, i) => this.bell(v, t + 0.1 + i * 0.07, hz(n) * p, 0.09, 0.9));
        break;
      case 'dash':
        this.noise(v, { t, filter: 'bandpass', freq: 500 * p, to: 3200 * p, q: 1.2, gain: 0.32, attack: 0.05, decay: 0.18 });
        this.noise(v, { t, filter: 'lowpass', freq: 1200, gain: 0.1, attack: 0.02, decay: 0.12 });
        break;
      case 'hitLight':
        this.noise(v, { t, filter: 'highpass', freq: 1500, gain: 0.32, decay: 0.025 });
        this.tone(v, { t, freq: 190 * p, to: 85 * p, gain: 0.38, decay: 0.09 });
        this.tone(v, { t, freq: 620 * p, to: 380 * p, type: 'triangle', gain: 0.14, decay: 0.03 });
        break;
      case 'hitHeavy': {
        const lp = this.filter(v, 'lowpass', 1400, 1, v.out);
        this.noise(v, { t, filter: 'lowpass', freq: 3500, to: 700, gain: 0.48, decay: 0.09 });
        this.tone(v, { t, freq: 130 * p, to: 40 * p, gain: 0.65, decay: 0.28 });
        this.tone(v, { t, freq: 95 * p, to: 60 * p, type: 'square', gain: 0.14, decay: 0.07, dest: lp });
        break;
      }
      case 'crit':
        this.designSfx(v, 'hitHeavy', t, p);
        this.bell(v, t + 0.01, hz(100) * p, 0.1, 0.5);
        this.bell(v, t + 0.04, hz(105) * p, 0.06, 0.4);
        this.noise(v, { t, filter: 'highpass', freq: 6000, gain: 0.08, decay: 0.15 });
        break;
      case 'shieldBlock':
        this.fm(v, { t, freq: 820 * p, ratio: 1.414, index: 3, indexTo: 0.2, gain: 0.16, decay: 0.45 });
        this.noise(v, { t, filter: 'highpass', freq: 3000, gain: 0.22, decay: 0.04 });
        this.tone(v, { t, freq: 150 * p, to: 110 * p, gain: 0.22, decay: 0.1 });
        break;
      case 'ko': {
        const lp = this.filter(v, 'lowpass', 3000, 2, v.out);
        this.glide(lp.frequency, t, 3000, 200, 0.9);
        this.tone(v, { t, freq: 900 * p, to: 55 * p, type: 'sawtooth', gain: 0.18, decay: 1, dest: lp });
        this.tone(v, { t, freq: 905 * p, to: 54 * p, type: 'sawtooth', gain: 0.12, decay: 1, dest: lp });
        this.tone(v, { t: t + 0.08, freq: 80 * p, to: 28 * p, gain: 0.75, decay: 1.3 });
        this.noise(v, { t: t + 0.08, filter: 'lowpass', freq: 600, to: 100, gain: 0.32, decay: 1.2 });
        break;
      }
      case 'lowHealth':
        // Lub-dub: one heartbeat per call.
        this.tone(v, { t, freq: 62 * p, to: 46 * p, gain: 0.45, attack: 0.01, decay: 0.16 });
        this.noise(v, { t, filter: 'lowpass', freq: 180, gain: 0.14, decay: 0.08 });
        this.tone(v, { t: t + 0.2, freq: 58 * p, to: 44 * p, gain: 0.32, attack: 0.01, decay: 0.2 });
        break;
      case 'ultReady':
        this.noise(v, { t, filter: 'highpass', freq: 5000, to: 9000, gain: 0.05, attack: 0.25, swell: true, decay: 0.3 });
        this.tone(v, { t, freq: hz(74) * p, gain: 0.06, attack: 0.2, decay: 0.5 });
        [86, 90, 93, 98].forEach((n, i) => this.bell(v, t + i * 0.06, hz(n) * p, 0.08, 0.5 + i * 0.1));
        break;
    }
  }

  // ── Element-flavoured combat sounds ──────────────────────────────────────

  /** Basic attack shot, element-flavoured (short, punchy, very frequent). pan -1..1 */
  shot(element: ElementKind, pan = 0): void {
    const g = this.ready();
    if (!g) return;
    const v = this.sfxVoice(g, { pan, volume: 0.5, send: 0.08 });
    const t = g.ctx.currentTime + 0.005;
    const p = rand(0.94, 1.06);
    switch (element) {
      case 'earth':
        this.tone(v, { t, freq: 160 * p, to: 70 * p, gain: 0.4, decay: 0.12 });
        this.noise(v, { t, filter: 'lowpass', freq: 900, q: 2, gain: 0.25, decay: 0.06 });
        break;
      case 'hydro':
        this.tone(v, { t, freq: 480 * p, to: 1250 * p, glide: 0.06, gain: 0.25, decay: 0.08 });
        this.noise(v, { t, filter: 'bandpass', freq: 1800, q: 4, gain: 0.1, decay: 0.05 });
        break;
      case 'gale':
        this.noise(v, { t, filter: 'bandpass', freq: 2500 * p, to: 5200 * p, q: 2, gain: 0.3, attack: 0.015, decay: 0.11 });
        this.tone(v, { t, freq: 1800 * p, gain: 0.04, decay: 0.05 });
        break;
      case 'plasma':
        this.fm(v, { t, freq: 880 * p, ratio: 2.01, index: 6, indexTo: 0.3, gain: 0.14, decay: 0.09 });
        this.tone(v, { t, freq: 1400 * p, to: 400 * p, type: 'square', gain: 0.03, decay: 0.06 });
        break;
      case 'nature':
        this.pluck(v, t, 660 * p, 0.28, 0.14, 5);
        this.noise(v, { t, filter: 'bandpass', freq: 3200, q: 2, gain: 0.08, decay: 0.04 });
        break;
      case 'void':
        this.tone(v, { t, freq: 220 * p, to: 150 * p, gain: 0.22, attack: 0.03, decay: 0.13 });
        this.tone(v, { t, freq: 224 * p, to: 147 * p, type: 'triangle', gain: 0.12, attack: 0.03, decay: 0.13 });
        this.noise(v, { t, filter: 'highpass', freq: 4000, gain: 0.05, attack: 0.06, swell: true, decay: 0.05 });
        break;
    }
  }

  /** Signature skill cast wind-up, element-flavoured (~0.4s). */
  cast(element: ElementKind, pan = 0): void {
    const g = this.ready();
    if (!g) return;
    this.castAt(g, element, pan, g.ctx.currentTime + 0.005);
  }

  private castAt(g: Graph, element: ElementKind, pan: number, t: number): void {
    const v = this.sfxVoice(g, { pan, volume: 0.8, send: 0.22 });
    switch (element) {
      case 'earth': {
        const lp = this.filter(v, 'lowpass', 500, 1, v.out);
        this.noise(v, { t, filter: 'lowpass', freq: 150, to: 900, q: 2, gain: 0.35, attack: 0.32, decay: 0.12 });
        this.tone(v, { t, freq: 50, to: 85, gain: 0.35, attack: 0.3, decay: 0.15 });
        this.tone(v, { t, freq: 82, to: 110, type: 'sawtooth', gain: 0.08, attack: 0.3, decay: 0.12, dest: lp });
        this.crackle(v, t + 0.1, 0.3, 4, 0.12, 'bandpass', 1200);
        break;
      }
      case 'hydro':
        this.noise(v, { t, filter: 'bandpass', freq: 400, to: 2600, q: 7, gain: 0.3, attack: 0.3, decay: 0.15 });
        for (let i = 0; i < 4; i++) {
          const f = rand(700, 1400);
          this.tone(v, { t: t + i * 0.08 + rand(0, 0.03), freq: f, to: f * 1.8, gain: 0.09, decay: 0.05 });
        }
        break;
      case 'gale':
        this.noise(v, { t, filter: 'bandpass', freq: 700, to: 4500, q: 3, gain: 0.3, attack: 0.3, decay: 0.15 });
        this.noise(v, { t: t + 0.05, filter: 'bandpass', freq: 1200, to: 6000, q: 5, gain: 0.14, attack: 0.25, decay: 0.15 });
        this.tone(v, { t, freq: 2637, gain: 0.025, attack: 0.3, swell: true, decay: 0.15 });
        this.tone(v, { t, freq: 3136, gain: 0.02, attack: 0.3, swell: true, decay: 0.15 });
        break;
      case 'plasma':
        this.fm(v, { t, freq: 110, to: 220, ratio: 1.5, index: 2, indexTo: 14, gain: 0.12, attack: 0.35, decay: 0.08 });
        this.crackle(v, t, 0.4, 6, 0.18, 'highpass', 3500);
        break;
      case 'nature':
        this.pluck(v, t, hz(62), 0.15, 0.4, 4);
        [74, 81, 88].forEach((n, i) => this.bell(v, t + i * 0.1, hz(n), 0.07, 0.4));
        this.noise(v, { t, filter: 'bandpass', freq: 2800, q: 1, gain: 0.12, attack: 0.2, decay: 0.2 });
        break;
      case 'void': {
        const lp = this.filter(v, 'lowpass', 200, 1.5, v.out);
        this.glide(lp.frequency, t, 200, 1400, 0.38);
        this.tone(v, { t, freq: 49, type: 'sawtooth', gain: 0.12, attack: 0.35, swell: true, decay: 0.12, dest: lp });
        this.tone(v, { t, freq: 49.7, type: 'sawtooth', gain: 0.12, attack: 0.35, swell: true, decay: 0.12, dest: lp });
        this.tone(v, { t, freq: 1661, gain: 0.025, attack: 0.35, swell: true, decay: 0.15 });
        this.tone(v, { t, freq: 1760, gain: 0.025, attack: 0.35, swell: true, decay: 0.15 });
        this.tone(v, { t, freq: 41, gain: 0.25, attack: 0.35, swell: true, decay: 0.15 });
        break;
      }
    }
  }

  /** Skill impact / explosion, element-flavoured (~0.5-0.9s, weighty). intensity 0.5..2. */
  impact(element: ElementKind, intensity = 1, pan = 0): void {
    const g = this.ready();
    if (!g) return;
    this.impactAt(g, element, intensity, pan, g.ctx.currentTime + 0.005);
  }

  private impactAt(g: Graph, element: ElementKind, intensity: number, pan: number, t: number): void {
    const k = clamp(intensity, 0.5, 2);
    const v = this.sfxVoice(g, { pan, volume: 0.55 + 0.2 * k, send: 0.15 + 0.12 * k });
    // Shared weight: sub thump plus a short broadband crack.
    this.boom(v, t, 0.4 * k ** 0.7, 0.35 + 0.25 * k);
    this.noise(v, { t, filter: 'lowpass', freq: 2500, to: 300, gain: 0.25 * k, decay: 0.12 + 0.08 * k });
    const tail = 0.5 + 0.2 * k;
    switch (element) {
      case 'earth': {
        const lp = this.filter(v, 'lowpass', 400, 1, v.out);
        this.noise(v, { t, filter: 'lowpass', freq: 900, to: 150, gain: 0.45, decay: tail });
        this.tone(v, { t, freq: 70, to: 35, type: 'square', gain: 0.15, decay: 0.4, dest: lp });
        this.crackle(v, t + 0.04, 0.45, Math.round(4 * k), 0.12, 'bandpass', 1100);
        break;
      }
      case 'hydro':
        this.noise(v, { t, filter: 'bandpass', freq: 2200, to: 400, q: 1.5, gain: 0.38, decay: tail });
        for (let i = 0; i < Math.round(5 * k); i++) {
          const f = rand(400, 900);
          this.tone(v, { t: t + 0.05 + Math.random() * 0.45, freq: f, to: f * 2.2, gain: 0.07, decay: 0.06 });
        }
        break;
      case 'gale':
        this.noise(v, { t, filter: 'bandpass', freq: 4000, to: 700, q: 2, gain: 0.42, attack: 0.02, decay: tail });
        this.noise(v, { t, filter: 'highpass', freq: 7000, gain: 0.09, decay: 0.4 });
        this.tone(v, { t, freq: 1320, to: 880, gain: 0.05, decay: 0.4 });
        break;
      case 'plasma':
        this.fm(v, { t, freq: 180, to: 90, ratio: 3.5, index: 18, indexTo: 0.5, gain: 0.22, decay: tail * 0.8 });
        this.crackle(v, t, 0.6, Math.round(6 * k), 0.2, 'highpass', 3500);
        this.tone(v, { t, freq: 2000, to: 200, glide: 0.15, type: 'square', gain: 0.04, decay: 0.2 });
        break;
      case 'nature':
        this.tone(v, { t, freq: 200, to: 120, type: 'triangle', gain: 0.35, decay: 0.25 });
        this.noise(v, { t, filter: 'bandpass', freq: 900, q: 5, gain: 0.28, decay: 0.08 });
        [78, 85, 90].forEach((n, i) => this.bell(v, t + 0.04 + i * 0.05, hz(n), 0.06, 0.6));
        this.noise(v, { t, filter: 'bandpass', freq: 3500, q: 0.8, gain: 0.12, attack: 0.05, decay: tail });
        break;
      case 'void': {
        const lp = this.filter(v, 'lowpass', 1200, 2, v.out);
        this.glide(lp.frequency, t, 1200, 120, tail + 0.2);
        for (const f of [55, 55.7, 82.4]) {
          this.tone(v, { t, freq: f, type: 'sawtooth', gain: 0.12, decay: tail + 0.2, dest: lp });
        }
        this.tone(v, { t: t + 0.05, freq: 1760, gain: 0.035, attack: 0.25, swell: true, decay: 0.4 });
        this.tone(v, { t: t + 0.05, freq: 1864, gain: 0.03, attack: 0.25, swell: true, decay: 0.4 });
        this.tone(v, { t, freq: 45, to: 30, gain: 0.35, decay: tail + 0.2 });
        break;
      }
    }
  }

  /** Ultimate activation: big riser + boom, element-flavoured (~1.2s). */
  ultimate(element: ElementKind): void {
    const g = this.ready();
    if (!g) return;
    const t = g.ctx.currentTime + 0.005;
    const rise = 0.7;
    const root = ELEMENT_ROOT[element];
    this.duck(g, 0.4, rise + 0.6, 1.2);
    const v = this.sfxVoice(g, { volume: 0.85, send: 0.35 });
    const lp = this.filter(v, 'lowpass', 600, 2, v.out);
    this.glide(lp.frequency, t, 600, 6000, rise);
    this.noise(v, { t, filter: 'bandpass', freq: 300, to: 7000, q: 2, gain: 0.22, attack: rise, swell: true, decay: 0.08 });
    for (const detune of [-10, 10]) {
      this.tone(v, { t, freq: root, to: root * 4, type: 'sawtooth', detune, gain: 0.07, attack: rise, swell: true, decay: 0.1, dest: lp });
    }
    this.tone(v, { t, freq: root / 2, to: root, gain: 0.18, attack: rise, swell: true, decay: 0.1 });
    this.castAt(g, element, 0, t + rise - 0.4);
    this.impactAt(g, element, 2, 0, t + rise);
  }

  // ── Music: transport & layers ────────────────────────────────────────────

  /** Crossfade to a music track (~1.5s). */
  playMusic(track: MusicTrack): void {
    this.track = track;
    const g = this.g;
    if (!g) return;
    const current = this.sessions.find((s) => s.stopAt === Infinity);
    if (current?.track === track) return;
    if (current) this.fadeOut(g, current);
    if (track !== 'none') this.startSession(g, track);
  }

  /** 0..1 battle intensity; layer gains glide toward the new mix. */
  setIntensity(level: number): void {
    this.intensity = clamp(level, 0, 1);
    const g = this.g;
    if (!g) return;
    const now = g.ctx.currentTime;
    for (const s of this.sessions) {
      if (s.track !== 'battle' || s.stopAt !== Infinity) continue;
      s.levels = battleLevels(this.intensity);
      for (const name of LAYER_NAMES) s.layers[name].gain.setTargetAtTime(s.levels[name], now, 0.6);
    }
  }

  /** Short musical stinger that ducks music briefly. */
  stinger(kind: 'victory' | 'defeat' | 'roundStart'): void {
    const g = this.ready();
    if (!g) return;
    const t = g.ctx.currentTime + 0.01;
    this.duck(g, 0.25, kind === 'roundStart' ? 0.6 : 1.6, 1.2);
    // Stingers sit on the music bus after the duck, so the music slider controls them.
    const v = this.openVoice(g, g.musicBus, g.musicSend, { volume: 0.9, send: 0.35 }, false);
    switch (kind) {
      case 'victory':
        this.chord(v, t, [62, 66, 69, 74], { gain: 0.05, attack: 0.04, hold: 0.5, release: 1.4, cutoff: 800, cutoffTo: 3200 });
        [86, 90, 93].forEach((n, i) => this.bell(v, t + 0.3 + i * 0.08, hz(n), 0.1, 1.4));
        this.boom(v, t, 0.6, 1);
        this.hat(v, t, 0.1, true);
        break;
      case 'defeat':
        this.chord(v, t, [47, 54, 59, 62], { gain: 0.05, attack: 0.1, hold: 0.6, release: 1.5, cutoff: 1200, cutoffTo: 400 });
        this.bell(v, t + 0.2, hz(71), 0.1, 1.5);
        this.tone(v, { t, freq: hz(23), gain: 0.35, attack: 0.2, hold: 0.5, decay: 1.4 });
        break;
      case 'roundStart':
        this.kick(v, t, 0.6);
        this.snare(v, t, 0.3);
        this.hat(v, t, 0.12, true);
        this.chord(v, t, [62, 69, 74], { gain: 0.05, attack: 0.01, hold: 0.15, release: 0.5, cutoff: 3000, cutoffTo: 1000 });
        this.bell(v, t, hz(74), 0.1, 0.5);
        this.bell(v, t + 0.12, hz(81), 0.12, 0.9);
        break;
    }
  }

  private duck(g: Graph, depth: number, hold: number, release: number): void {
    const now = g.ctx.currentTime;
    for (const param of [g.musicDuck.gain, g.musicWetDuck.gain]) {
      param.cancelScheduledValues(now);
      param.setValueAtTime(param.value, now);
      param.setTargetAtTime(depth, now, 0.03);
      param.setTargetAtTime(1, now + hold, release / 3);
    }
  }

  private startSession(g: Graph, track: Exclude<MusicTrack, 'none'>): void {
    const { ctx } = g;
    const now = ctx.currentTime;
    const nodes: AudioNode[] = [];
    const gain = (value: number, dest: AudioNode): GainNode => {
      const node = ctx.createGain();
      node.gain.value = value;
      node.connect(dest);
      nodes.push(node);
      return node;
    };
    const out = gain(0, g.musicDuck);
    const wet = gain(0, g.musicWetDuck);
    for (const param of [out.gain, wet.gain]) {
      param.setValueAtTime(0, now);
      param.linearRampToValueAtTime(1, now + CROSSFADE_S);
    }
    // Each layer has its own level and reverb amount (drums dry, bells wet).
    const layer = (send: number): GainNode => {
      const node = gain(0, out);
      node.connect(gain(send, wet));
      return node;
    };
    const layers: Record<LayerName, GainNode> = {
      pad: layer(0.6), perc: layer(0.1), drums: layer(0.12), hats: layer(0.08), bass: layer(0.04),
      arp: layer(0.35), lead: layer(0.45), bell: layer(0.7), air: layer(0.6),
    };
    const levels = track === 'menu' ? MENU_LEVELS : battleLevels(this.intensity);
    for (const name of LAYER_NAMES) layers[name].gain.value = levels[name];

    const def = TRACKS[track];
    this.sessions.push({
      track, out, wet, layers, levels, nodes,
      stepDur: 60 / def.bpm / 4,
      step: 0,
      nextTime: now + 0.1,
      stopAt: Infinity,
      rng: mulberry32(def.seed),
      barIntensity: this.intensity,
    });
    this.startScheduler();
  }

  private fadeOut(g: Graph, s: MusicSession): void {
    const now = g.ctx.currentTime;
    for (const param of [s.out.gain, s.wet.gain]) {
      param.cancelScheduledValues(now);
      param.setValueAtTime(param.value, now);
      param.linearRampToValueAtTime(0, now + CROSSFADE_S);
    }
    s.stopAt = now + CROSSFADE_S + 0.1;
  }

  // ── Music: lookahead scheduler ───────────────────────────────────────────

  private startScheduler(): void {
    if (this.schedulerId === null) this.schedulerId = setInterval(() => this.tick(), SCHEDULER_INTERVAL_MS);
  }

  private stopScheduler(): void {
    if (this.schedulerId !== null) clearInterval(this.schedulerId);
    this.schedulerId = null;
  }

  /** Schedules every 16th-note step that falls inside the lookahead window. */
  private tick(): void {
    const g = this.g;
    if (!g || g.ctx.state !== 'running') return;
    const now = g.ctx.currentTime;
    for (const s of this.sessions) {
      if (s.nextTime < now) {
        // Timers were throttled (background tab): skip ahead on the grid instead of bunching notes.
        const missed = Math.ceil((now - s.nextTime) / s.stepDur);
        s.step += missed;
        s.nextTime += missed * s.stepDur;
      }
      while (s.nextTime < now + SCHEDULE_AHEAD_S && s.nextTime < s.stopAt) {
        this.scheduleStep(g, s, s.nextTime);
        s.step++;
        s.nextTime += s.stepDur;
      }
    }
    this.sessions = this.sessions.filter((s) => {
      if (s.stopAt > now) return true;
      for (const node of s.nodes) node.disconnect();
      return false;
    });
    if (this.sessions.length === 0) this.stopScheduler();
  }

  private scheduleStep(g: Graph, s: MusicSession, t: number): void {
    const def = TRACKS[s.track];
    const bar = Math.floor(s.step / STEPS_PER_BAR);
    const pos = s.step % STEPS_PER_BAR;
    if (pos === 0) {
      // Re-seed per bar (repeating every 32 bars) so variation is consistent, not random noise.
      s.rng = mulberry32(def.seed * 7919 + (bar % 32));
      s.barIntensity = this.intensity;
    }
    const chord = at(def.chords, bar);
    if (s.track === 'menu') this.menuStep(g, s, chord, bar, pos, t);
    else this.battleStep(g, s, chord, bar, pos, t);
  }

  /** Calm and majestic: slow pad chords, a bell motif, a soft arpeggio and air. */
  private menuStep(g: Graph, s: MusicSession, chord: Chord, bar: number, pos: number, t: number): void {
    const L = s.layers;
    const barLen = s.stepDur * STEPS_PER_BAR;
    if (pos === 0) {
      this.chord(this.musicVoice(g, L.pad), t, chord.notes, {
        gain: 0.035, attack: 1.2, hold: barLen - 0.9, release: 2.2, cutoff: 700, cutoffTo: 1600,
      });
      const bass = this.musicVoice(g, L.bass);
      this.tone(bass, { t, freq: hz(chord.bass + 12), type: 'triangle', gain: 0.12, attack: 0.4, hold: barLen - 0.6, decay: 1.2 });
      if (bar % 2 === 0) {
        this.noise(this.musicVoice(g, L.air), {
          t, filter: 'bandpass', freq: 2400, to: 3600, q: 0.6, gain: 0.012, attack: barLen, decay: barLen,
        });
      }
    }
    const upper = chord.notes.filter((n) => n >= 57).map((n) => n + 12);
    const motifHit = pos === 0 || pos === 6 || pos === 10 || (pos === 14 && s.rng() < 0.4);
    if (motifHit) {
      const pan = s.rng() * 0.8 - 0.4;
      this.bell(this.musicVoice(g, L.bell, pan), t, hz(at(upper, s.rng() * upper.length)), 0.045, 1.6);
    }
    if (pos % 2 === 0 && s.rng() > 0.3) {
      const pan = pos % 4 === 0 ? -0.3 : 0.3;
      this.pluck(this.musicVoice(g, L.arp, pan), t, hz(at(chord.notes, pos / 2 + 1) + 12), 0.03, 0.5, 3);
    }
  }

  /** Driving but warm: layered drums, sub bass, arp and lead that follow intensity. */
  private battleStep(g: Graph, s: MusicSession, chord: Chord, bar: number, pos: number, t: number): void {
    const L = s.layers;
    const on = (name: LayerName): boolean => s.levels[name] > 0.01;
    const barLen = s.stepDur * STEPS_PER_BAR;
    const loopBar = bar % 8;

    if (pos === 0 && on('pad')) {
      this.chord(this.musicVoice(g, L.pad), t, chord.notes, {
        gain: 0.022, attack: 0.25, hold: barLen - 0.3, release: 0.8, cutoff: 900, cutoffTo: 2200,
      });
    }
    if (pos === 0 && on('air') && bar % 2 === 0) {
      this.noise(this.musicVoice(g, L.air), {
        t, filter: 'bandpass', freq: 1800, to: 4000, q: 0.7, gain: 0.01, attack: barLen, decay: barLen,
      });
    }

    // Light percussion: always present.
    if (pos % 8 === 0) this.kick(this.musicVoice(g, L.perc), t, 0.45);
    if (pos % 8 === 4) this.hat(this.musicVoice(g, L.perc, 0.2), t, 0.05);

    if (on('drums')) {
      const extraKicks: readonly number[] = at(KICK_VARIANTS, s.rng() * KICK_VARIANTS.length);
      if (extraKicks.includes(pos)) this.kick(this.musicVoice(g, L.drums), t, 0.4);
      if (pos === 4 || pos === 12) this.snare(this.musicVoice(g, L.drums), t, 0.28);
      else if (loopBar === 7 && pos >= 13) this.snare(this.musicVoice(g, L.drums), t, 0.1 + 0.06 * (pos - 13));
      else if (pos === 7 && s.rng() < 0.3) this.snare(this.musicVoice(g, L.drums), t, 0.06);
    }

    if (on('hats')) {
      const sixteenths = s.barIntensity > 0.8;
      if (pos === 14 && bar % 2 === 1) this.hat(this.musicVoice(g, L.hats, -0.25), t, 0.07, true);
      else if (sixteenths || pos % 2 === 0) this.hat(this.musicVoice(g, L.hats, -0.25), t, pos % 4 === 2 ? 0.09 : 0.045);
    }

    if (on('bass') && (BASS_STEPS as readonly number[]).includes(pos)) {
      const offset = pos === 6 || pos === 14 ? 12 : pos === 11 ? 7 : 0;
      this.bassNote(this.musicVoice(g, L.bass), t, hz(chord.bass + 12 + offset), s.stepDur * 2.2);
    }

    if (on('arp')) {
      const tones = chord.notes.filter((n) => n >= 54);
      const pattern = [...tones, ...tones.map((n) => n + 12)];
      const upDown = [...pattern, ...pattern.slice(1, -1).reverse()];
      this.pluck(this.musicVoice(g, L.arp, pos % 2 === 0 ? -0.35 : 0.35), t, hz(at(upDown, s.step) + 12), 0.035, 0.18, 7);
    }

    if (on('lead') && (pos === 0 || (pos === 8 && s.rng() < 0.6) || (pos === 14 && s.rng() < 0.3))) {
      const pitchClasses = chord.notes.map((n) => n % 12);
      const fits = LEAD_SCALE.filter((n) => pitchClasses.includes(n % 12));
      const pool = fits.length > 0 ? fits : LEAD_SCALE;
      const length = s.stepDur * (pos === 14 ? 2 : 6);
      this.leadNote(this.musicVoice(g, L.lead, 0.1), t, hz(at(pool, s.rng() * pool.length)), length);
    }
  }

  private bassNote(v: Voice, t: number, freq: number, decay: number): void {
    const lp = this.filter(v, 'lowpass', 900, 2, v.out);
    this.glide(lp.frequency, t, 900, 180, decay);
    this.tone(v, { t, freq, type: 'sawtooth', gain: 0.07, decay, dest: lp });
    this.tone(v, { t, freq: freq / 2, gain: 0.2, decay: decay * 1.1 });
  }

  /** Singing lead with delayed-feel vibrato. */
  private leadNote(v: Voice, t: number, freq: number, length: number): void {
    const env: Envelope = { gain: 0.05, attack: 0.06, hold: length * 0.6, decay: length * 0.6 };
    const main = this.tone(v, { t, freq, type: 'triangle', ...env });
    const octave = this.tone(v, { t, freq: freq * 2, ...env, gain: env.gain * 0.25 });
    const lfo = v.g.ctx.createOscillator();
    lfo.frequency.value = 5.2;
    const depth = this.gain(v, 0);
    depth.gain.setValueAtTime(0, t);
    depth.gain.linearRampToValueAtTime(14, t + length * 0.5);
    lfo.connect(depth);
    depth.connect(main.detune);
    depth.connect(octave.detune);
    this.play(v, lfo, t, t + length * 1.3);
  }
}

// ─── Procedural buffers ─────────────────────────────────────────────────────

function whiteNoise(ctx: BaseAudioContext): AudioBuffer {
  const buffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

/**
 * Stereo hall impulse response: decaying noise whose tail darkens over time
 * (a one-pole lowpass closing as it decays), plus a few early reflections.
 */
function impulseResponse(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const rate = ctx.sampleRate;
  const length = Math.floor(rate * seconds);
  const preDelay = Math.floor(rate * 0.012);
  const ir = ctx.createBuffer(2, length, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = ir.getChannelData(ch);
    let smoothed = 0;
    for (let i = preDelay; i < length; i++) {
      const x = (i - preDelay) / (length - preDelay);
      smoothed += (0.9 - 0.75 * x) * (Math.random() * 2 - 1 - smoothed);
      data[i] = smoothed * Math.exp(-6 * x);
    }
    for (let r = 0; r < 8; r++) {
      const index = preDelay + Math.floor(rate * rand(0.006, 0.08));
      if (index < length) data[index] = (data[index] ?? 0) + (Math.random() * 2 - 1) * 0.5 * (1 - r / 8);
    }
  }
  return ir;
}
