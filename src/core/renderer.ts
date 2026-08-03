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
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  // r183+: PCFShadowMap is the soft PCF filter (PCFSoftShadowMap is deprecated).
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5) * quality.renderScale);
  renderer.setSize(container.clientWidth, container.clientHeight);
  container.appendChild(renderer.domElement);
  return renderer;
}
