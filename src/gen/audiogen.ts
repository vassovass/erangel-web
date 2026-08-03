// Fully synthesized audio: every buffer computed sample-by-sample at init.
// No samples, no downloads. The audio stream (12) refines timbres; this is
// the playable base: gunshot, footsteps, reload, hits, wind bed.

export class AudioSystem {
  private ctx: AudioContext;
  private master: GainNode;
  private buffers = new Map<string, AudioBuffer>();
  private windGain: GainNode | null = null;
  private started = false;

  constructor() {
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.8;
    this.master.connect(this.ctx.destination);
    this.bake();
    // Browsers gate audio on first gesture.
    const resume = () => {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      if (!this.started) {
        this.started = true;
        this.startWind();
      }
    };
    window.addEventListener('pointerdown', resume);
    window.addEventListener('keydown', resume);
  }

  private bake(): void {
    const sr = this.ctx.sampleRate;

    this.buffers.set('shot', this.render(1.1, (t, rnd) => {
      // Crack: 4ms of hot noise. Body: 90Hz thump sweeping down. Tail: decaying noise.
      const crack = t < 0.004 ? (rnd() * 2 - 1) * Math.exp(-t * 900) : 0;
      const body = Math.sin(2 * Math.PI * (95 - t * 55) * t) * Math.exp(-t * 26) * 0.9;
      const tail = (rnd() * 2 - 1) * Math.exp(-t * 7) * 0.28;
      const slap = (rnd() * 2 - 1) * Math.exp(-t * 120) * 0.5;
      return crack * 1.2 + body + tail + slap;
    }, 0.9));

    this.buffers.set('shot-far', this.render(1.4, (t, rnd) => {
      const boom = Math.sin(2 * Math.PI * (70 - t * 25) * t) * Math.exp(-t * 9) * 0.8;
      const tail = (rnd() * 2 - 1) * Math.exp(-t * 3.2) * 0.3;
      return boom + tail;
    }, 0.5));

    for (const [name, tone, decay] of [
      ['step-grass', 900, 55],
      ['step-dirt', 500, 45],
      ['step-road', 1600, 70],
    ] as const) {
      this.buffers.set(name, this.render(0.12, (t, rnd) => {
        const n = (rnd() * 2 - 1) * Math.exp(-t * decay);
        const crunch = (rnd() > 0.5 ? 1 : -1) * Math.exp(-t * decay * 2) * 0.4;
        return lowpassish(n + crunch, t, tone);
      }, 0.32));
    }

    this.buffers.set('dry', this.render(0.09, (t, rnd) => {
      return (rnd() * 2 - 1) * Math.exp(-t * 200) * (t < 0.01 ? 1 : 0.3) + Math.sin(2 * Math.PI * 2400 * t) * Math.exp(-t * 300) * 0.4;
    }, 0.5));

    this.buffers.set('mag-out', this.render(0.14, (t, rnd) => {
      return (rnd() * 2 - 1) * Math.exp(-t * 90) * 0.6 + Math.sin(2 * Math.PI * 800 * t) * Math.exp(-t * 120) * 0.5;
    }, 0.45));

    this.buffers.set('mag-in', this.render(0.16, (t, rnd) => {
      return (rnd() * 2 - 1) * Math.exp(-t * 70) * 0.5 + Math.sin(2 * Math.PI * 500 * t) * Math.exp(-t * 80) * 0.7;
    }, 0.5));

    this.buffers.set('bolt', this.render(0.12, (t, rnd) => {
      return Math.sin(2 * Math.PI * 1800 * t) * Math.exp(-t * 220) * 0.7 + (rnd() * 2 - 1) * Math.exp(-t * 150) * 0.4;
    }, 0.45));

    this.buffers.set('hit', this.render(0.1, (t) => {
      return Math.sin(2 * Math.PI * 1300 * t) * Math.exp(-t * 90) * 0.6 + Math.sin(2 * Math.PI * 1950 * t) * Math.exp(-t * 120) * 0.35;
    }, 0.4));

    this.buffers.set('headshot', this.render(0.14, (t) => {
      return Math.sin(2 * Math.PI * 1600 * t) * Math.exp(-t * 70) * 0.7 + Math.sin(2 * Math.PI * 2400 * t) * Math.exp(-t * 100) * 0.4;
    }, 0.45));

    // Bullet whiz: fast noise sweep with a falling pitch feel.
    this.buffers.set('whiz', this.render(0.22, (t, rnd) => {
      const env = Math.sin(Math.min(t / 0.22, 1) * Math.PI);
      const tone = Math.sin(2 * Math.PI * (2600 - t * 5200) * t) * 0.3;
      return ((rnd() * 2 - 1) * 0.7 + tone) * env * Math.exp(-t * 4);
    }, 0.5));

    this.buffers.set('pickup', this.render(0.16, (t) => {
      return (Math.sin(2 * Math.PI * 620 * t) + Math.sin(2 * Math.PI * 930 * t) * 0.6) * Math.exp(-t * 24);
    }, 0.4));

    this.buffers.set('heal', this.render(0.5, (t) => {
      const a = Math.sin(2 * Math.PI * 520 * t) * Math.exp(-t * 6);
      const b = t > 0.12 ? Math.sin(2 * Math.PI * 660 * (t - 0.12)) * Math.exp(-(t - 0.12) * 6) : 0;
      const c = t > 0.24 ? Math.sin(2 * Math.PI * 780 * (t - 0.24)) * Math.exp(-(t - 0.24) * 6) : 0;
      return (a + b * 0.8 + c * 0.7) * 0.5;
    }, 0.35));
  }

  private zoneGain: GainNode | null = null;

  /** Rising drone as the player nears / crosses the blue zone wall. */
  setZoneProximity(metersInside: number): void {
    if (this.ctx.state !== 'running') return;
    if (!this.zoneGain) {
      const src = this.ctx.createBufferSource();
      src.buffer = this.render(2.0, (t, rnd) => {
        return (
          Math.sin(2 * Math.PI * 52 * t) * 0.5 +
          Math.sin(2 * Math.PI * 78.2 * t) * 0.3 +
          (rnd() * 2 - 1) * 0.12
        );
      }, 0.8);
      src.loop = true;
      const filt = this.ctx.createBiquadFilter();
      filt.type = 'lowpass';
      filt.frequency.value = 240;
      this.zoneGain = this.ctx.createGain();
      this.zoneGain.gain.value = 0;
      src.connect(filt);
      filt.connect(this.zoneGain);
      this.zoneGain.connect(this.master);
      src.start();
    }
    // Silent >120m inside, swells approaching the wall, loud outside.
    const target = metersInside < 0 ? 0.34 : metersInside > 120 ? 0 : 0.22 * (1 - metersInside / 120);
    this.zoneGain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.4);
  }

  private render(seconds: number, fn: (t: number, rnd: () => number) => number, gain: number): AudioBuffer {
    const sr = this.ctx.sampleRate;
    const len = Math.floor(seconds * sr);
    const buf = this.ctx.createBuffer(2, len, sr);
    let seed = 48271;
    const rnd = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        data[i] = fn(i / sr, rnd) * gain;
      }
    }
    return buf;
  }

  play(name: string, opts: { volume?: number; rate?: number; detuneJitter?: number } = {}): void {
    const buf = this.buffers.get(name);
    if (!buf || this.ctx.state !== 'running') return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const jitter = opts.detuneJitter ?? 0.06;
    src.playbackRate.value = (opts.rate ?? 1) * (1 - jitter / 2 + Math.random() * jitter);
    const g = this.ctx.createGain();
    g.gain.value = opts.volume ?? 1;
    src.connect(g);
    g.connect(this.master);
    src.start();
  }

  /** Positional one-shot: volume/pan from listener-relative offset. */
  playAt(name: string, dx: number, dy: number, dz: number, refDist = 18): void {
    const buf = this.buffers.get(name);
    if (!buf || this.ctx.state !== 'running') return;
    const dist = Math.hypot(dx, dy, dz);
    const vol = Math.min(1, refDist / Math.max(dist, 1));
    if (vol < 0.02) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const g = this.ctx.createGain();
    g.gain.value = vol * vol;
    const pan = this.ctx.createStereoPanner();
    pan.pan.value = Math.max(-1, Math.min(1, dx / Math.max(dist, 1)));
    src.connect(g);
    g.connect(pan);
    pan.connect(this.master);
    src.start();
  }

  private startWind(): void {
    // Looping pink-ish noise bed with slow LFO.
    const sr = this.ctx.sampleRate;
    const len = sr * 4;
    const buf = this.ctx.createBuffer(2, len, sr);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      let seed = ch === 0 ? 12345 : 67890;
      for (let i = 0; i < len; i++) {
        seed = (seed * 16807) % 2147483647;
        const white = seed / 2147483647 * 2 - 1;
        b0 = 0.997 * b0 + 0.03 * white;
        b1 = 0.985 * b1 + 0.012 * white;
        b2 = 0.95 * b2 + 0.006 * white;
        data[i] = (b0 + b1 + b2) * 0.5;
      }
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    this.windGain = this.ctx.createGain();
    this.windGain.gain.value = 0.11;
    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoGain = this.ctx.createGain();
    lfoGain.gain.value = 0.04;
    lfo.connect(lfoGain);
    lfoGain.connect(this.windGain.gain);
    src.connect(this.windGain);
    this.windGain.connect(this.master);
    src.start();
    lfo.start();
  }
}

/** Crude one-pole flavor for step sounds (offline, per-sample approximation). */
function lowpassish(v: number, t: number, cutoffHz: number): number {
  return v * Math.min(1, cutoffHz / 2000);
}
