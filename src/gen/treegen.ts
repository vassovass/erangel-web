import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { hash2 } from './noise';

// Bark maps and dead-tree geometry. Everything else that used to live here —
// the grass atlas, the crown-sized foliage cards and the old trunk/card layouts
// — moved to veg-atlas.ts / veg-blades.ts / veg-trees.ts when vegetation went
// from "one billboard per clump" to real geometry plus leaf-cluster crowns.

/** Counter-based deterministic stream (no Math.random anywhere in gen paths). */
function stream(seed: number): () => number {
  let i = 1;
  return () => hash2(seed, i++);
}

function rgb(r: number, g: number, b: number, a = 1): string {
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${a})`;
}

function newCanvas(w: number, h: number): { c: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, w, h);
  return { c, ctx };
}

// ---------------------------------------------------------------------------
// Bark: albedo + CPU-sobel normal map
// ---------------------------------------------------------------------------

export type BarkKind = 'oak' | 'birch' | 'pine' | 'dead';

export interface BarkMaps {
  map: THREE.CanvasTexture;
  normalMap: THREE.DataTexture;
}

const BARK_W = 128;
const BARK_H = 256;

// Cycle 3 desaturation. Cycle 2's pine base ran [116,76,48] — saturation 59%
// with a hard red push — and once the instance tint multiplied through it the
// trunks sampled at #401808 / #602810 (S 83-88%). That is fantasy redwood. A
// Scots pine or an oak in rural Eastern Europe sits at S 10-25% grey-brown and
// the PUBG reference trunk measures S 4%; these bases land the RENDERED trunk
// near hsv(30, 0.26, 0.33) once the near-neutral instance tint is applied.
// Cycle 4: birch came down from [198,194,186]. Multiplied by an instance tint of
// 0xe2dfd8 that was a near-paper-white 0.87, the rendered trunk was the
// BRIGHTEST object in the treeline frame — brighter than the sky — where the
// reference's birches read sRGB ~150-190 lit with heavy dark lenticel banding.
const BARK_BASE: Record<BarkKind, [number, number, number]> = {
  oak: [120, 110, 100],
  birch: [168, 162, 150],
  pine: [122, 112, 100],
  dead: [124, 116, 104],
};

function normalFromCanvas(ctx: CanvasRenderingContext2D, w: number, h: number, strength: number): THREE.DataTexture {
  const src = ctx.getImageData(0, 0, w, h).data;
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    lum[i] = (src[i * 4] * 0.299 + src[i * 4 + 1] * 0.587 + src[i * 4 + 2] * 0.114) / 255;
  }
  const at = (x: number, y: number) => lum[((y + h) % h) * w + ((x + w) % w)];
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (at(x - 1, y) - at(x + 1, y)) * strength;
      const dy = (at(x, y - 1) - at(x, y + 1)) * strength;
      const len = Math.hypot(dx, dy, 1);
      const o = (y * w + x) * 4;
      data[o] = ((dx / len) * 0.5 + 0.5) * 255;
      data[o + 1] = ((dy / len) * 0.5 + 0.5) * 255;
      data[o + 2] = (1 / len) * 0.5 * 255 + 127;
      data[o + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.MirroredRepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

export function makeBarkMaps(kind: BarkKind, seed: number): BarkMaps {
  const { c, ctx } = newCanvas(BARK_W, BARK_H);
  const r = stream(seed);
  const base = BARK_BASE[kind];

  ctx.fillStyle = rgb(base[0], base[1], base[2], 1);
  ctx.fillRect(0, 0, BARK_W, BARK_H);

  if (kind === 'birch') {
    // Birch is the opposite of every other bark here: a pale sheet broken by
    // dark HORIZONTAL lenticels and the odd charcoal scar. Without the
    // white-bark species a Eastern-European treeline never reads right.
    for (let i = 0; i < 220; i++) {
      const y = r() * BARK_H;
      const x = r() * BARK_W;
      const w = 4 + r() * 26;
      const mul = 0.24 + r() * 0.3;
      ctx.fillStyle = rgb(base[0] * mul, base[1] * mul, base[2] * mul, 0.55 + r() * 0.4);
      ctx.fillRect(x, y, w, 0.8 + r() * 2.2);
      if (x + w > BARK_W) ctx.fillRect(x - BARK_W, y, w, 0.8 + r() * 2.2);
    }
    for (let i = 0; i < 16; i++) {
      const y = r() * BARK_H;
      const x = r() * BARK_W;
      ctx.fillStyle = rgb(52 + r() * 26, 46 + r() * 22, 40 + r() * 18, 0.5);
      ctx.beginPath();
      ctx.ellipse(x, y, 5 + r() * 12, 2.5 + r() * 6, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    for (let i = 0; i < 1800; i++) {
      const mul = 0.82 + r() * 0.26;
      ctx.fillStyle = rgb(base[0] * mul, base[1] * mul, base[2] * mul, 0.3);
      ctx.fillRect(r() * BARK_W, r() * BARK_H, 1 + r() * 2.2, 1 + r() * 1.4);
    }
    // Heavy lenticel BANDING: ~14 dark bands up the trunk, each a broken run of
    // jittered dashes 3-8 px tall at a 0.35 value multiplier. Without these a
    // birch is a white PVC pole, which is exactly how the treeline read.
    for (let band = 0; band < 14; band++) {
      const y = ((band + 0.5) / 14) * BARK_H + (r() - 0.5) * 7;
      const th = 3 + r() * 5;
      let x = -r() * 30;
      while (x < BARK_W) {
        const seg = 6 + r() * 34;
        if (r() > 0.22) {
          const mul = 0.30 + r() * 0.14;
          ctx.fillStyle = rgb(base[0] * mul, base[1] * mul, base[2] * mul, 0.55 + r() * 0.35);
          ctx.fillRect(x, y + (r() - 0.5) * 2.2, seg, th * (0.6 + r() * 0.7));
        }
        x += seg + r() * 14;
      }
    }
  } else {
    // Vertical fissures, drawn three times so the texture wraps the trunk.
    const stroke = (x: number, wide: number, mul: number, alpha: number, wob: number) => {
      for (const off of [-BARK_W, 0, BARK_W]) {
        ctx.strokeStyle = rgb(base[0] * mul, base[1] * mul, base[2] * mul, alpha);
        ctx.lineWidth = wide;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(x + off, -8);
        let px = x + off;
        for (let y = 0; y <= BARK_H + 8; y += 32) {
          const nx = x + off + Math.sin((y / BARK_H) * Math.PI * 2 + wob) * wide * 1.4 + (r() - 0.5) * wob * 3;
          ctx.quadraticCurveTo((px + nx) * 0.5, y - 16, nx, y);
          px = nx;
        }
        ctx.stroke();
      }
    };
    for (let i = 0; i < 30; i++) stroke(r() * BARK_W, 2.5 + r() * 6.5, 0.42 + r() * 0.14, 0.85, 0.6 + r() * 1.4);
    for (let i = 0; i < 44; i++) stroke(r() * BARK_W, 1.2 + r() * 3.0, 1.16 + r() * 0.26, 0.55, 0.4 + r() * 1.2);

    const plates = kind === 'pine' ? 90 : 46;
    for (let i = 0; i < plates; i++) {
      const x = r() * BARK_W;
      const y = r() * BARK_H;
      const mul = 0.6 + r() * 0.7;
      ctx.strokeStyle = rgb(base[0] * mul, base[1] * mul, base[2] * mul, 0.5);
      ctx.lineWidth = 1 + r() * 1.8;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + (r() - 0.5) * 22, y + (r() - 0.5) * 10);
      ctx.stroke();
    }
    for (let i = 0; i < 2600; i++) {
      const mul = 0.66 + r() * 0.68;
      ctx.fillStyle = rgb(base[0] * mul, base[1] * mul, base[2] * mul, 0.35);
      ctx.fillRect(r() * BARK_W, r() * BARK_H, 1 + r() * 1.6, 1 + r() * 2.6);
    }
  }

  const normalMap = normalFromCanvas(ctx, BARK_W, BARK_H, kind === 'birch' ? 2.0 : 3.4);

  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = THREE.RepeatWrapping;
  map.wrapT = THREE.MirroredRepeatWrapping;
  map.anisotropy = 4;
  return { map, normalMap };
}

// ---------------------------------------------------------------------------
// Dead snag (unit space: 1.0 == tree height)
// ---------------------------------------------------------------------------

export function deadTreeGeometry(seed: number): THREE.BufferGeometry {
  const r = stream(seed);
  const parts: THREE.BufferGeometry[] = [];
  const th = 0.86;
  const trunk = new THREE.CylinderGeometry(0.014, 0.038, th, 8, 1, true);
  trunk.translate(0, th * 0.5, 0);
  parts.push(trunk);
  // Root flare: a snag that meets the ground as a sliced cylinder reads as a
  // pole pushed into a lit plane, which is the whole of the contact finding.
  const flare = new THREE.CylinderGeometry(0.038, 0.074, 0.075, 8, 1, true);
  flare.translate(0, 0.0, 0);
  parts.push(flare);
  // Pitched 35-55 deg off vertical like a living branch, and tapered — cycle 2
  // ran 0.6-1.2 rad, i.e. very nearly horizontal sticks.
  for (let i = 0; i < 5; i++) {
    const len = 0.14 + r() * 0.22;
    const b = new THREE.CylinderGeometry(0.003, 0.012, len, 3, 1, true);
    b.translate(0, len * 0.5, 0);
    const m = new THREE.Matrix4().makeRotationZ(0.58 + r() * 0.42);
    m.premultiply(new THREE.Matrix4().makeRotationY(r() * Math.PI * 2));
    m.setPosition(0, 0.34 + r() * 0.44, 0);
    b.applyMatrix4(m);
    parts.push(b);
  }
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return merged ?? trunk;
}
