import * as THREE from 'three';
import type { Engine, System } from '../core/engine';
import type { Heightfield } from '../gen/terraingen';

// Scripted 30s benchmark flythrough: a wide orbit over the map plus a low
// sweep near the deck, which is the worst case (grass + terrain overdraw).
// Writes window.__BENCH_RESULT__ JSON for tools/capture.mjs --bench.

const WARMUP_S = 3;
const MEASURE_S = 27;

export class BenchFly implements System {
  private t = 0;
  private measuring = false;
  private done = false;
  private drawCallsMax = 0;
  private trianglesMax = 0;

  constructor(private engine: Engine, private hf: Heightfield) {}

  update(dt: number): void {
    if (this.done) return;
    this.t += dt;

    const total = WARMUP_S + MEASURE_S;
    const phase = Math.min(this.t / total, 1);
    const cam = this.engine.camera;

    // First 60%: orbit at altitude. Last 40%: low pass along the coastal road.
    if (phase < 0.6) {
      const a = (phase / 0.6) * Math.PI * 1.6 - Math.PI * 0.3;
      const r = 380 - phase * 180;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const y = this.hf.height(x, z) + 40 - phase * 20;
      cam.position.set(x, y, z);
      cam.lookAt(Math.cos(a + 0.5) * r * 0.4, 10, Math.sin(a + 0.5) * r * 0.4);
    } else {
      const t2 = (phase - 0.6) / 0.4;
      const x = -400 + t2 * 700;
      const z = 140 - t2 * 40;
      const y = this.hf.height(x, z) + 2.0;
      cam.position.set(x, y, z);
      cam.lookAt(x + 80, this.hf.height(x + 80, z - 5) + 3, z - 5);
    }

    if (!this.measuring && this.t >= WARMUP_S) {
      this.measuring = true;
      this.engine.resetStats();
    }
    const info = this.engine.renderer.info.render;
    if (info.calls > this.drawCallsMax) this.drawCallsMax = info.calls;
    if (info.triangles > this.trianglesMax) this.trianglesMax = info.triangles;

    if (this.t >= total) {
      this.done = true;
      const stats = this.engine.stats(MEASURE_S);
      const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
      window.__BENCH_RESULT__ = JSON.stringify({
        avgFps: Math.round(stats.avgFps * 10) / 10,
        p1Low: Math.round(stats.p1Low * 10) / 10,
        frames: stats.frames,
        drawCalls: this.drawCallsMax,
        triangles: this.trianglesMax,
        jsHeapMB: mem ? Math.round(mem.usedJSHeapSize / 1048576) : null,
        pixelRatio: this.engine.renderer.getPixelRatio(),
        renderer: this.rendererString(),
      });
    }
  }

  private rendererString(): string {
    const gl = this.engine.renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'unknown';
  }
}
