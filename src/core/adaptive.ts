import * as THREE from 'three';
import type { System } from './engine';
import type { PostPipeline } from '../post/pipeline';
import { quality } from './settings';

// Dynamic resolution. On this GPU the frame is fillrate-bound, not geometry- or
// draw-call-bound: alpha-tested vegetation, a full-screen SMAA pass and a
// mipmap-blur bloom all scale with PIXELS, so resolution is the one lever that
// buys frame time without deleting content. Rendering at 0.7 scale costs half
// the pixels of native 1080p and is far less visible in motion than cutting the
// grass radius or the shadow map.
//
// The controller is deliberately sluggish and asymmetric:
//   * it judges on a MEDIAN of the last 24 frames, so one GC hitch or a
//     shader compile cannot move it;
//   * it drops fast (a stutter is felt now) and recovers slowly (a resolution
//     step that oscillates is worse than one that settles a notch low);
//   * it holds for a cooldown after every change, so a change is measured
//     before the next one is considered.

const WINDOW = 24;
const STEPS = [1.0, 0.88, 0.78, 0.68, 0.58, 0.5];
const COOLDOWN_S = 1.1;
/** Frame budget headroom before stepping back up (avoid oscillation). */
const UP_MARGIN = 0.82;

export class AdaptiveResolution implements System {
  /**
   * Start PART WAY DOWN the ladder, not at native. Climbing up when there is
   * headroom is free; the first two seconds spent discovering that native
   * resolution does not fit are two seconds of the worst frame-rate the player
   * ever sees, and first impressions of an FPS are made in that window.
   */
  private idx = 3;
  private samples: number[] = [];
  private cooldown = 1.5;
  private basePixelRatio: number;
  private enabled = true;
  /** Frame-time budget in seconds (1/targetFps). */
  private budget: number;

  constructor(
    private renderer: THREE.WebGLRenderer,
    private pipeline: PostPipeline | null,
    targetFps = 45
  ) {
    this.budget = 1 / targetFps;
    this.basePixelRatio = Math.min(window.devicePixelRatio, 1.5);
    const q = new URLSearchParams(location.search);
    if (q.has('scale') || q.get('adaptive') === '0') {
      // An explicit scale (review captures, A/B tests) pins the resolution.
      this.enabled = false;
    }
    this.apply();
  }

  get scale(): number {
    return STEPS[this.idx];
  }

  private apply(): void {
    const s = STEPS[this.idx];
    this.renderer.setPixelRatio(this.basePixelRatio * s * quality.renderScale);
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.pipeline?.setSize(w, h);
  }

  update(dt: number): void {
    if (!this.enabled) return;
    this.samples.push(dt);
    if (this.samples.length > WINDOW) this.samples.shift();
    if (this.cooldown > 0) {
      this.cooldown -= dt;
      return;
    }
    if (this.samples.length < WINDOW) return;

    const sorted = [...this.samples].sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];

    if (median > this.budget && this.idx < STEPS.length - 1) {
      this.idx++;
      this.apply();
      this.cooldown = COOLDOWN_S;
    } else if (median < this.budget * UP_MARGIN && this.idx > 0) {
      this.idx--;
      this.apply();
      this.cooldown = COOLDOWN_S * 2;
    }
  }
}
