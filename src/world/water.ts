import * as THREE from 'three';

// Sea plane around the island. Deliberately simple for Phase 0 — the world
// visual pass owns making it beautiful (animated normals, shore blend).

export function createWater(): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(6000, 6000);
  const mat = new THREE.MeshStandardMaterial({
    color: 0x16323a,
    roughness: 0.14,
    metalness: 0.0,
    transparent: true,
    opacity: 0.96,
    envMapIntensity: 1.1,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.35;
  mesh.receiveShadow = false;
  return mesh;
}
