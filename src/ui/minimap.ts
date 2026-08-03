import { MAP_SIZE, type Heightfield } from '../gen/terraingen';
import type { ZoneController } from '../match/zonecontroller';
import type { PlayerController } from '../player/controller';

// PUBG-style map: a cartographic world image baked once on the CPU from the
// heightfield (splat colors, parcel tints, hillshade, roads, sea), shown as a
// corner minimap and an M-toggled full map with live zone circles.

const BAKE_RES = 440;

export class Minimap {
  private world: HTMLCanvasElement;
  private corner: HTMLCanvasElement;
  private full: HTMLCanvasElement;
  private fullVisible = false;

  constructor(private hf: Heightfield) {
    this.world = document.createElement('canvas');
    this.world.width = this.world.height = BAKE_RES;
    this.bake();

    this.corner = document.createElement('canvas');
    this.corner.width = this.corner.height = 232;
    this.corner.style.cssText =
      'position:absolute;left:22px;bottom:22px;width:200px;height:200px;border:2px solid rgba(255,255,255,0.35);' +
      'border-radius:3px;box-shadow:0 2px 12px rgba(0,0,0,0.6);opacity:0.94;';
    this.full = document.createElement('canvas');
    this.full.width = this.full.height = 880;
    this.full.style.cssText =
      'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:76vmin;height:76vmin;' +
      'border:2px solid rgba(255,255,255,0.4);box-shadow:0 4px 40px rgba(0,0,0,0.8);display:none;';
    const hud = document.getElementById('hud')!;
    hud.appendChild(this.corner);
    hud.appendChild(this.full);
  }

  toggleFull(): void {
    this.fullVisible = !this.fullVisible;
    this.full.style.display = this.fullVisible ? 'block' : 'none';
  }

  private bake(): void {
    const ctx = this.world.getContext('2d')!;
    const img = ctx.createImageData(BAKE_RES, BAKE_RES);
    const d = img.data;
    const sunX = -0.6, sunZ = -0.5;
    let p = 0;
    for (let j = 0; j < BAKE_RES; j++) {
      for (let i = 0; i < BAKE_RES; i++) {
        const x = ((i + 0.5) / BAKE_RES - 0.5) * MAP_SIZE;
        const z = ((j + 0.5) / BAKE_RES - 0.5) * MAP_SIZE;
        const h = this.hf.height(x, z);
        let r: number, g: number, b: number;
        if (h < 0.4) {
          const deep = Math.min(1, (0.4 - h) / 14);
          r = 46 - deep * 18; g = 92 - deep * 30; b = 110 - deep * 28;
        } else {
          const s = this.hf.surface(x, z);
          const w = s.splat;
          // Base: parcel-tinted grass.
          const tone = s.field.tone;
          r = 118 + tone * 42; g = 128 + tone * 26; b = 66 + tone * 14;
          // Dirt / rock / road overlays.
          r = r * (1 - w.dirt) + 141 * w.dirt;
          g = g * (1 - w.dirt) + 116 * w.dirt;
          b = b * (1 - w.dirt) + 84 * w.dirt;
          r = r * (1 - w.rock) + 132 * w.rock;
          g = g * (1 - w.rock) + 126 * w.rock;
          b = b * (1 - w.rock) + 118 * w.rock;
          const road = w.road > 0.55 ? 1 : 0;
          r = r * (1 - road) + 78 * road;
          g = g * (1 - road) + 76 * road;
          b = b * (1 - road) + 74 * road;
          // Beach.
          const beach = Math.max(0, 1 - Math.abs(h - 1.4) / 1.4);
          r = r * (1 - beach) + 190 * beach;
          g = g * (1 - beach) + 174 * beach;
          b = b * (1 - beach) + 136 * beach;
          // Hillshade.
          const n = this.hf.normal(x, z, 4);
          const shade = 0.72 + Math.max(0, n[0] * sunX + n[2] * sunZ) * 0.75 + (n[1] - 0.9) * 1.4;
          r *= shade; g *= shade; b *= shade;
          // Altitude tint.
          const alt = Math.min(1, h / 90);
          r += alt * 26; g += alt * 20; b += alt * 18;
        }
        d[p] = Math.max(0, Math.min(255, r));
        d[p + 1] = Math.max(0, Math.min(255, g));
        d[p + 2] = Math.max(0, Math.min(255, b));
        d[p + 3] = 255;
        p += 4;
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  private worldToMap(x: number, z: number, size: number): [number, number] {
    return [((x / MAP_SIZE) + 0.5) * size, ((z / MAP_SIZE) + 0.5) * size];
  }

  private drawZone(ctx: CanvasRenderingContext2D, zone: ZoneController, size: number, scale: number): void {
    // Current circle: blue.
    const [cx, cz] = this.worldToMap(zone.center.x, zone.center.z, size);
    ctx.strokeStyle = 'rgba(80, 140, 255, 0.9)';
    ctx.lineWidth = 2.4 * scale;
    ctx.beginPath();
    ctx.arc(cx, cz, (zone.radius / MAP_SIZE) * size, 0, Math.PI * 2);
    ctx.stroke();
    // Next circle: white (only while waiting).
    if (!zone.isShrinking && !zone.finished) {
      const [tx, tz] = this.worldToMap(zone.targetCenter.x, zone.targetCenter.z, size);
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 1.6 * scale;
      ctx.beginPath();
      ctx.arc(tx, tz, (zone.targetRadius / MAP_SIZE) * size, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  update(player: PlayerController, zone: ZoneController): void {
    // Corner: zoomed crop centred on the player.
    const c = this.corner.getContext('2d')!;
    const size = this.corner.width;
    const viewWorld = 340; // metres shown across the corner map
    const srcSize = (viewWorld / MAP_SIZE) * BAKE_RES;
    const [wx, wz] = this.worldToMap(player.position.x, player.position.z, BAKE_RES);
    c.fillStyle = '#15242c';
    c.fillRect(0, 0, size, size);
    c.drawImage(
      this.world,
      wx - srcSize / 2, wz - srcSize / 2, srcSize, srcSize,
      0, 0, size, size
    );
    // Zone circles in corner space.
    c.save();
    const cscale = size / srcSize;
    c.translate(size / 2 - wx * cscale, size / 2 - wz * cscale);
    c.scale(cscale * (BAKE_RES / BAKE_RES), cscale);
    this.drawZone(c, zone, BAKE_RES, 1 / cscale);
    c.restore();
    c.save();
    c.translate(size / 2, size / 2);
    c.rotate(-player.yaw);
    c.fillStyle = '#ffffff';
    c.strokeStyle = 'rgba(0,0,0,0.7)';
    c.lineWidth = 1.4;
    c.beginPath();
    c.moveTo(0, -8);
    c.lineTo(5.5, 7);
    c.lineTo(0, 3.5);
    c.lineTo(-5.5, 7);
    c.closePath();
    c.fill();
    c.stroke();
    c.restore();

    // Full map.
    if (this.fullVisible) {
      const f = this.full.getContext('2d')!;
      const fsize = this.full.width;
      f.drawImage(this.world, 0, 0, fsize, fsize);
      f.save();
      const fscale = fsize / BAKE_RES;
      f.scale(fscale, fscale);
      this.drawZone(f, zone, BAKE_RES, 1.4 / fscale);
      f.restore();
      const [px, pz] = this.worldToMap(player.position.x, player.position.z, fsize);
      f.save();
      f.translate(px, pz);
      f.rotate(-player.yaw);
      f.fillStyle = '#ffffff';
      f.strokeStyle = 'rgba(0,0,0,0.8)';
      f.lineWidth = 2;
      f.beginPath();
      f.moveTo(0, -10);
      f.lineTo(7, 9);
      f.lineTo(0, 4.5);
      f.lineTo(-7, 9);
      f.closePath();
      f.fill();
      f.stroke();
      f.restore();
    }
  }
}
