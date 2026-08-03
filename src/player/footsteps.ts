import type { System } from '../core/engine';
import type { AudioSystem } from '../gen/audiogen';
import type { Heightfield } from '../gen/terraingen';
import type { PlayerController } from './controller';

/** Surface-aware footstep audio driven by distance travelled. */
export class Footsteps implements System {
  private acc = 0;
  private lastX = 0;
  private lastZ = 0;

  constructor(
    private player: PlayerController,
    private hf: Heightfield,
    private audio: AudioSystem
  ) {
    this.lastX = player.position.x;
    this.lastZ = player.position.z;
  }

  fixedUpdate(): void {
    const dx = this.player.position.x - this.lastX;
    const dz = this.player.position.z - this.lastZ;
    this.lastX = this.player.position.x;
    this.lastZ = this.player.position.z;
    const d = Math.hypot(dx, dz);
    if (this.player.speed2D < 0.5) {
      this.acc = 0;
      return;
    }
    this.acc += d;
    const stride = this.player.isSprinting ? 2.9 : 2.2;
    if (this.acc >= stride) {
      this.acc = 0;
      const w = this.hf.splat(this.player.position.x, this.player.position.z);
      const name = w.road > 0.5 ? 'step-road' : w.dirt > Math.max(w.grass, w.rock) ? 'step-dirt' : 'step-grass';
      this.audio.play(name, { volume: this.player.isSprinting ? 0.75 : 0.45, detuneJitter: 0.18 });
    }
  }
}
