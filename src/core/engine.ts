import * as THREE from 'three';

export interface System {
  /** Fixed-step simulation update at 60Hz. */
  fixedUpdate?(dt: number): void;
  /** Per-render-frame update (animations, camera smoothing). */
  update?(dt: number, alpha: number): void;
}

const FIXED_DT = 1 / 60;
const MAX_STEPS = 5;

/**
 * Render/update loop with a fixed 60Hz simulation step decoupled from the
 * render rate, plus frame-time sampling for the bench harness.
 */
export interface RenderPipeline {
  render(dt: number): void;
  setSize(w: number, h: number): void;
}

export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** Optional post pipeline; when set it replaces the direct renderer call. */
  pipeline: RenderPipeline | null = null;

  private systems: System[] = [];
  private accumulator = 0;
  private last = 0;
  private running = false;
  private frameTimes: number[] = [];
  private beforeRender: Array<(dt: number) => void> = [];

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    window.addEventListener('resize', () => this.onResize());
  }

  add(system: System): void {
    this.systems.push(system);
  }

  onBeforeRender(fn: (dt: number) => void): void {
    this.beforeRender.push(fn);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    this.renderer.setAnimationLoop(() => this.tick());
  }

  stop(): void {
    this.running = false;
    this.renderer.setAnimationLoop(null);
  }

  private tick(): void {
    const now = performance.now();
    let frame = (now - this.last) / 1000;
    this.last = now;
    if (frame > 0.25) frame = 0.25; // tab-switch hitch guard
    this.frameTimes.push(frame);
    if (this.frameTimes.length > 4000) this.frameTimes.splice(0, 2000);

    this.accumulator += frame;
    let steps = 0;
    while (this.accumulator >= FIXED_DT && steps < MAX_STEPS) {
      for (const s of this.systems) s.fixedUpdate?.(FIXED_DT);
      this.accumulator -= FIXED_DT;
      steps++;
    }
    if (steps === MAX_STEPS) this.accumulator = 0;

    const alpha = this.accumulator / FIXED_DT;
    for (const s of this.systems) s.update?.(frame, alpha);
    for (const fn of this.beforeRender) fn(frame);
    if (this.pipeline) this.pipeline.render(frame);
    else this.renderer.render(this.scene, this.camera);
  }

  /** Frame-time stats over the last `seconds` of samples (for the bench). */
  stats(seconds = 30): { avgFps: number; p1Low: number; frames: number } {
    let total = 0;
    let count = 0;
    for (let i = this.frameTimes.length - 1; i >= 0 && total < seconds; i--) {
      total += this.frameTimes[i];
      count++;
    }
    const window_ = this.frameTimes.slice(this.frameTimes.length - count);
    if (window_.length === 0) return { avgFps: 0, p1Low: 0, frames: 0 };
    const avg = window_.reduce((a, b) => a + b, 0) / window_.length;
    const sorted = [...window_].sort((a, b) => b - a); // worst first
    const p1Count = Math.max(1, Math.floor(sorted.length * 0.01));
    const p1Avg = sorted.slice(0, p1Count).reduce((a, b) => a + b, 0) / p1Count;
    return { avgFps: 1 / avg, p1Low: 1 / p1Avg, frames: window_.length };
  }

  resetStats(): void {
    this.frameTimes.length = 0;
  }

  private onResize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.pipeline?.setSize(w, h);
  }
}
