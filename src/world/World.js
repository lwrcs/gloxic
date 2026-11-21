import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { MapGeometry } from '../shared/MapGeometry.js';

// The rendered level: MapGeometry (grid, colliders, spawns, pathfinding,
// line of sight; shared with the server) plus meshes and lights.

export class World extends MapGeometry {
  constructor(game, def) {
    super(def);
    this.game = game;
    this.group = new THREE.Group();
    this.meshes = []; // THREE.Mesh[] (audio room probing)
    this.materials = new Map();
    this.raycaster = new THREE.Raycaster();
    this.buildEnvironment();
    for (const b of this.boxes) this.addMesh(b);
    game.scene.add(this.group);
  }

  buildEnvironment() {
    const env = this.def.environment ?? {};
    const scene = this.game.scene;
    scene.background = new THREE.Color(env.sky ?? '#000000');
    scene.fog = new THREE.Fog(scene.background, env.fogNear ?? 30, env.fogFar ?? 120);

    const hemi = new THREE.HemisphereLight('#ffffff', '#444444', env.ambientIntensity ?? 0.6);
    this.group.add(hemi);

    const sun = new THREE.DirectionalLight(env.sunColor ?? '#ffffff', env.sunIntensity ?? 2.2);
    const span = Math.max(this.halfW, this.halfD);
    sun.position.set(span * 0.6, span * 1.2, span * 0.4);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -span, right: span, top: span, bottom: -span, near: 1, far: span * 4 });
    sun.shadow.camera.updateProjectionMatrix();
    sun.shadow.bias = -0.0005;
    this.group.add(sun);
  }

  // `shade` is the surface's brightness for the lighting pass; the dither
  // turns it into dot density, so low values read as black-with-light.
  material(tile) {
    const shade = tile.shade ?? 0.3;
    if (!this.materials.has(shade)) {
      this.materials.set(shade, new THREE.MeshLambertMaterial({ color: new THREE.Color(shade, shade, shade) }));
    }
    return this.materials.get(shade);
  }

  addMesh({ x, y, z, w, h, d, tile }) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), this.material(tile));
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.outline = tile.outline ?? CONFIG.outlines.world;
    mesh.updateMatrixWorld();
    this.group.add(mesh);
    this.meshes.push(mesh);
    return mesh;
  }

  dispose() {
    this.game.scene.remove(this.group);
    this.group.traverse((o) => o.geometry?.dispose());
    for (const m of this.materials.values()) m.dispose();
  }
}
