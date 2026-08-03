import * as THREE from 'three';

// The blue zone wall: open cylinder, additive fresnel-edged shader with slow
// vertical energy scroll. Radius/centre driven by the zone controller.

export class ZoneWall {
  readonly mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;

  constructor() {
    const geo = new THREE.CylinderGeometry(1, 1, 400, 96, 1, true);
    this.mat = new THREE.ShaderMaterial({
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uColor: { value: new THREE.Color(0x2e6fd8) },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        varying vec3 vWorldPos;
        void main() {
          vUv = uv;
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorldPos = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform vec3 uColor;
        varying vec2 vUv;
        varying vec3 vWorldPos;
        void main() {
          // Denser near the ground, scrolling energy bands, hex-ish shimmer.
          float vertical = 1.0 - vUv.y;
          float base = 0.10 + vertical * 0.22;
          float bands = sin(vWorldPos.y * 0.55 - uTime * 1.2) * 0.5 + 0.5;
          float shimmer = sin(vWorldPos.x * 0.8 + uTime * 0.7) * sin(vWorldPos.z * 0.8 - uTime * 0.9) * 0.5 + 0.5;
          float alpha = base + bands * 0.06 + shimmer * 0.05;
          gl_FragColor = vec4(uColor * (1.1 + bands * 0.4), alpha);
        }
      `,
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 50;
  }

  set(center: THREE.Vector3, radius: number): void {
    this.mesh.position.set(center.x, 120, center.z);
    this.mesh.scale.set(radius, 1, radius);
  }

  update(dt: number): void {
    this.mat.uniforms.uTime.value += dt;
  }
}
