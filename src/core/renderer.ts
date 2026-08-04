import * as THREE from 'three';
import { quality } from './settings';

export function createRenderer(container: HTMLElement): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({
    antialias: quality.msaa,
    powerPreference: 'high-performance',
    stencil: false,
    // Keep the drawing buffer so puppeteer screenshots capture the frame.
    preserveDrawingBuffer: true,
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  // NOTE: three disables tone mapping whenever the render target is not the
  // canvas, so with the post pipeline active (the default, and what capture
  // uses) this curve does NOT run — the frame is composed linear and the scene
  // is authored for that (see the colour-space note in sky.ts). This exposure
  // only applies on ?nopost, and 0.6 cancels the ACES `exposure / 0.6` term so
  // the two paths land on roughly the same mid-tones.
  renderer.toneMappingExposure = 0.6;
  renderer.shadowMap.enabled = true;
  // r183+: PCFShadowMap is the soft PCF filter (PCFSoftShadowMap is deprecated).
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5) * quality.renderScale);
  renderer.setSize(container.clientWidth, container.clientHeight);
  container.appendChild(renderer.domElement);
  return renderer;
}
