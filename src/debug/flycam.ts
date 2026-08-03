import * as THREE from 'three';
import type { System } from '../core/engine';
import type { Input } from '../core/input';

/** Free-fly camera for Phase 0 review and debugging. */
export class FlyCamera implements System {
  yaw = 0;
  pitch = 0;
  speed = 24;

  constructor(private camera: THREE.PerspectiveCamera, private input: Input) {
    const e = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
    this.yaw = e.y;
    this.pitch = e.x;
  }

  update(dt: number): void {
    const look = this.input.consumeLook();
    this.yaw -= look.dx * 0.0022;
    this.pitch -= look.dy * 0.0022;
    this.pitch = Math.max(-1.55, Math.min(1.55, this.pitch));
    this.camera.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));

    const dir = new THREE.Vector3();
    if (this.input.isDown('forward')) dir.z -= 1;
    if (this.input.isDown('back')) dir.z += 1;
    if (this.input.isDown('left')) dir.x -= 1;
    if (this.input.isDown('right')) dir.x += 1;
    if (dir.lengthSq() > 0) {
      dir.normalize().applyQuaternion(this.camera.quaternion);
      const mult = this.input.isDown('sprint') ? 4.5 : 1;
      this.camera.position.addScaledVector(dir, this.speed * mult * dt);
    }
    if (this.input.isDown('jump')) this.camera.position.y += this.speed * dt;
    if (this.input.isDown('crouch')) this.camera.position.y -= this.speed * dt;
    this.input.endFrame();
  }
}
