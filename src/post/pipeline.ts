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
  VignetteEffect,
} from 'postprocessing';

// Post stack (pmndrs postprocessing: effects merge into few fullscreen passes,
// which matters on a fillrate-bound iGPU). MSAA is off; SMAA replaces it.
// The grading wow-loop (stream 4) owns the final look: tune the exported
// effects/dials, keep the pass structure.

export class PostPipeline {
  readonly composer: EffectComposer;
  readonly bloom: BloomEffect;
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

    this.bloom = new BloomEffect({
      intensity: 0.5,
      luminanceThreshold: 0.83,
      luminanceSmoothing: 0.25,
      mipmapBlur: true,
    });
    this.vignette = new VignetteEffect({ darkness: 0.42, offset: 0.28 });
    // PUBG grade: slightly desaturated warmth with lifted contrast.
    this.hueSat = new HueSaturationEffect({ saturation: -0.04 });
    this.contrast = new BrightnessContrastEffect({ brightness: 0.0, contrast: 0.07 });
    this.grain = new NoiseEffect({ blendFunction: BlendFunction.OVERLAY, premultiply: true });
    this.grain.blendMode.opacity.value = 0.05;

    this.composer.addPass(new EffectPass(camera, smaa));
    this.composer.addPass(
      new EffectPass(camera, this.bloom, this.hueSat, this.contrast, this.vignette, this.grain)
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
