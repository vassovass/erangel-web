import * as THREE from 'three';
import {
  BlendFunction,
  BloomEffect,
  BrightnessContrastEffect,
  EffectComposer,
  EffectPass,
  HueSaturationEffect,
  NoiseEffect,
  RenderPass,
  SMAAEffect,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
} from 'postprocessing';

// Post stack (pmndrs postprocessing: effects merge into few fullscreen passes,
// which matters on a fillrate-bound iGPU). MSAA is off; SMAA replaces it.
// The grading wow-loop (stream 4) owns the final look: tune the exported
// effects/dials, keep the pass structure.
//
// TONE CURVE — the composer renders into a HalfFloat target, and three disables
// renderer.toneMapping for any target that is not the canvas. Without an
// explicit operator here the frame went to screen as raw linear radiance with
// no toe and no shoulder, which put every capture inside about 2.5 stops
// (measured ground p1..p99 = 0.201..0.515, against 0.006..0.799 on the PUBG
// reference). ACES runs FIRST of the display-referred effects, after bloom
// (which has to see the real HDR values) and before hue/contrast/vignette so
// the grade operates on display-referred pixels. renderer.toneMappingExposure
// is 0.6, which cancels the `exposure / 0.6` term inside three's ACES fit, so
// the operator runs at unity and the scene is authored against it directly.

export class PostPipeline {
  readonly composer: EffectComposer;
  readonly bloom: BloomEffect;
  readonly toneMapping: ToneMappingEffect;
  readonly vignette: VignetteEffect;
  readonly hueSat: HueSaturationEffect;
  readonly contrast: BrightnessContrastEffect;
  readonly grain: NoiseEffect;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
    this.composer = new EffectComposer(renderer, {
      frameBufferType: THREE.HalfFloatType,
      multisampling: 0,
    });
    this.composer.addPass(new RenderPass(scene, camera));

    const smaa = new SMAAEffect();

    // HDR frame: the analytic sky's sun lobe exceeds 1.0 by design, so the
    // threshold sits above it or the whole sun side of the sky blooms out.
    this.bloom = new BloomEffect({
      intensity: 0.3,
      luminanceThreshold: 1.12,
      luminanceSmoothing: 0.18,
      mipmapBlur: true,
    });
    this.toneMapping = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC });
    this.vignette = new VignetteEffect({ darkness: 0.42, offset: 0.28 });
    // PUBG grade: ACES already desaturates the highlights, so the saturation
    // trim comes back to zero and a small positive lift replaces it.
    this.hueSat = new HueSaturationEffect({ saturation: 0.06 });
    this.contrast = new BrightnessContrastEffect({ brightness: 0.0, contrast: 0.05 });
    this.grain = new NoiseEffect({ blendFunction: BlendFunction.OVERLAY, premultiply: true });
    this.grain.blendMode.opacity.value = 0.05;

    this.composer.addPass(new EffectPass(camera, smaa));
    this.composer.addPass(
      new EffectPass(
        camera,
        this.bloom,
        this.toneMapping,
        this.hueSat,
        this.contrast,
        this.vignette,
        this.grain
      )
    );
  }

  setSize(w: number, h: number): void {
    this.composer.setSize(w, h);
  }

  render(dt: number): void {
    this.composer.render(dt);
  }

  dispose(): void {
    this.composer.dispose();
  }
}
