import type { ElementKind } from '../types';

const ELEMENT_TONES: Record<ElementKind, [number, number]> = {
  earth: [82.41, 123.47],
  hydro: [196, 293.66],
  gale: [329.63, 493.88],
  plasma: [440, 659.25],
  nature: [146.83, 220],
  void: [73.42, 110],
};

export class AudioEngine {
  private context?: AudioContext;
  private master?: GainNode;

  async unlock(): Promise<void> {
    if (!this.context) {
      this.context = new AudioContext();
      this.master = this.context.createGain();
      this.master.gain.value = 0.22;
      this.master.connect(this.context.destination);
    }
    if (this.context.state === 'suspended') await this.context.resume();
  }

  cast(element: ElementKind): void {
    if (!this.context || !this.master) return;
    const now = this.context.currentTime;
    const [fundamental, overtone] = ELEMENT_TONES[element];
    const oscillator = this.context.createOscillator();
    const shimmer = this.context.createOscillator();
    const gain = this.context.createGain();
    const filter = this.context.createBiquadFilter();
    oscillator.type = element === 'plasma' ? 'sawtooth' : element === 'void' ? 'triangle' : 'sine';
    shimmer.type = 'sine';
    oscillator.frequency.setValueAtTime(fundamental, now);
    oscillator.frequency.exponentialRampToValueAtTime(overtone, now + 0.24);
    shimmer.frequency.setValueAtTime(overtone * 2, now);
    shimmer.detune.value = 7;
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(4200, now);
    filter.frequency.exponentialRampToValueAtTime(600, now + 0.42);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.18, now + 0.025);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.44);
    oscillator.connect(filter);
    shimmer.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    oscillator.start(now);
    shimmer.start(now);
    oscillator.stop(now + 0.46);
    shimmer.stop(now + 0.46);
  }

  impact(element: ElementKind): void {
    if (!this.context || !this.master) return;
    const now = this.context.currentTime;
    const frames = Math.floor(this.context.sampleRate * 0.25);
    const buffer = this.context.createBuffer(1, frames, this.context.sampleRate);
    const channel = buffer.getChannelData(0);
    for (let index = 0; index < frames; index += 1) {
      const falloff = 1 - index / frames;
      channel[index] = (Math.random() * 2 - 1) * falloff * falloff;
    }
    const source = this.context.createBufferSource();
    const filter = this.context.createBiquadFilter();
    const gain = this.context.createGain();
    const [fundamental] = ELEMENT_TONES[element];
    filter.type = 'bandpass';
    filter.frequency.value = fundamental * 5;
    filter.Q.value = 0.7;
    gain.gain.setValueAtTime(0.2, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.26);
    source.buffer = buffer;
    source.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    source.start(now);
  }

  async dispose(): Promise<void> {
    if (this.context && this.context.state !== 'closed') await this.context.close();
    this.context = undefined;
    this.master = undefined;
  }
}
