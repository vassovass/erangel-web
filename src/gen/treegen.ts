import * as THREE from 'three';
import { hash2 } from './noise';

// Procedural tree assets: canvas-drawn foliage cluster + grass clump alpha
// textures, and per-species trunk/card geometry. Everything instanced by
// vegetation.ts — this file only makes the shared building blocks.

export function makeFoliageTexture(species: 'broadleaf' | 'pine', seed: number): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, 256, 256);

  if (species === 'broadleaf') {
    // Clumped leaf mass: hundreds of small overlapping ellipses, denser centre.
    for (let i = 0; i < 900; i++) {
      const a = hash2(seed, i) * Math.PI * 2;
      const r = Math.pow(hash2(seed + 1, i), 0.6) * 108;
      const x = 128 + Math.cos(a) * r * 1.15;
      const y = 118 + Math.sin(a) * r * 0.85;
      const size = 3 + hash2(seed + 2, i) * 6;
      const g = 0.32 + hash2(seed + 3, i) * 0.3;
      const light = 1 - r / 130;
      ctx.fillStyle = `rgba(${Math.floor(58 + light * 55)}, ${Math.floor((g + light * 0.22) * 190)}, ${Math.floor(38 + light * 30)}, ${0.75 + hash2(seed + 4, i) * 0.25})`;
      ctx.beginPath();
      ctx.ellipse(x, y, size, size * 0.7, a, 0, Math.PI * 2);
      ctx.fill();
    }
  } else {
    // Pine: layered drooping needle fans down a vertical axis.
    for (let layer = 0; layer < 9; layer++) {
      const y = 26 + layer * 25;
      const width = 22 + layer * 11;
      for (let i = 0; i < 60; i++) {
        const t = i / 60;
        const x = 128 + (t - 0.5) * 2 * width * (0.85 + hash2(seed, layer * 100 + i) * 0.3);
        const g = 0.30 + hash2(seed + 1, layer * 100 + i) * 0.18;
        ctx.strokeStyle = `rgba(${Math.floor(30 + g * 40)}, ${Math.floor(g * 200)}, ${Math.floor(30 + g * 46)}, 0.85)`;
        ctx.lineWidth = 2.2;
        ctx.beginPath();
        ctx.moveTo(128, y - 16);
        ctx.quadraticCurveTo(x, y - 6, x + (x - 128) * 0.12, y + 10 + hash2(seed + 2, i) * 6);
        ctx.stroke();
      }
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Grass clump: a fan of tapered blade strokes with a hot-spot near the roots. */
export function makeGrassClumpTexture(seed: number): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, 256, 128);
  for (let i = 0; i < 90; i++) {
    const baseX = 24 + hash2(seed, i) * 208;
    const lean = (hash2(seed + 1, i) - 0.5) * 70;
    const h = 52 + hash2(seed + 2, i) * 66;
    const w = 1.6 + hash2(seed + 3, i) * 2.4;
    const g = 0.36 + hash2(seed + 4, i) * 0.34;
    const dry = hash2(seed + 5, i);
    // Erangel palette: yellow-green meadow, only a minority of dry straw blades.
    const r = Math.floor(48 + dry * 72);
    const green = Math.floor(88 + g * 130);
    const b = Math.floor(24 + dry * 18);
    const grad = ctx.createLinearGradient(baseX, 128, baseX + lean, 128 - h);
    grad.addColorStop(0, `rgba(${Math.floor(r * 0.55)}, ${Math.floor(green * 0.55)}, ${Math.floor(b * 0.6)}, 0.95)`);
    grad.addColorStop(1, `rgba(${r}, ${green}, ${b}, 0.9)`);
    ctx.strokeStyle = grad;
    ctx.lineWidth = w;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(baseX, 130);
    ctx.quadraticCurveTo(baseX + lean * 0.3, 128 - h * 0.6, baseX + lean, 128 - h);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

export interface TreeSpeciesGeo {
  trunk: THREE.BufferGeometry;
  /** Card positions/rotations in local space: [x, y, z, yaw, w, h]. */
  cards: [number, number, number, number, number, number][];
}

export function treeGeometry(species: 'broadleaf' | 'pine', seed: number): TreeSpeciesGeo {
  if (species === 'broadleaf') {
    const height = 7 + hash2(seed, 1) * 3.5;
    const trunk = new THREE.CylinderGeometry(0.13, 0.24, height * 0.55, 6);
    trunk.translate(0, height * 0.275, 0);
    const cards: TreeSpeciesGeo['cards'] = [];
    const crownY = height * 0.62;
    const crownR = 1.7 + hash2(seed, 2) * 1.1;
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI + hash2(seed, i + 3) * 0.5;
      cards.push([
        (hash2(seed, i + 7) - 0.5) * crownR * 0.9,
        crownY + (hash2(seed, i + 11) - 0.35) * 1.6,
        (hash2(seed, i + 13) - 0.5) * crownR * 0.9,
        a,
        crownR * 2.4,
        crownR * 2.1,
      ]);
    }
    return { trunk, cards };
  }
  const height = 9 + hash2(seed, 1) * 4;
  const trunk = new THREE.CylinderGeometry(0.1, 0.22, height * 0.45, 6);
  trunk.translate(0, height * 0.225, 0);
  const cards: TreeSpeciesGeo['cards'] = [];
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI;
    cards.push([0, height * 0.55, 0, a, 2.6 + hash2(seed, 5) * 0.8, height * 0.85]);
  }
  return { trunk, cards };
}
