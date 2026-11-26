import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { MapGeometry } from '../shared/MapGeometry.js';

// The rendered level: MapGeometry (grid, colliders, spawns, pathfinding,
// line of sight; shared with the server) plus meshes and lights.

const LETTERS = {
  A: ['.#.', '#.#', '###', '#.#', '#.#'],
  B: ['##.', '#.#', '##.', '#.#', '##.'],
};

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
    this.buildSiteMarks();
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

  // Bomb sites: a pale border on the ground and the site's letter painted
  // big in the middle. Decoration only (no colliders).
  buildSiteMarks() {
    const sites = Object.values(this.sites);
    if (!sites.length) return;
    const paint = new THREE.MeshLambertMaterial({ color: new THREE.Color(0.95, 0.95, 0.95) });
    this.materials.set('site-paint', paint);
    const quad = (x, z, w, d) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), paint);
      m.rotation.x = -Math.PI / 2;
      m.position.set(x, 0.02, z);
      m.receiveShadow = true;
      this.group.add(m);
    };
    const c = this.cell;
    for (const s of sites) {
      const a = this.cellToWorld(s.x0, s.z0);
      const b = this.cellToWorld(s.x1, s.z1);
      const x0 = a.x - c / 2;
      const x1 = b.x + c / 2;
      const z0 = a.z - c / 2;
      const z1 = b.z + c / 2;
      const t = 0.25; // border width
      quad((x0 + x1) / 2, z0 + t / 2, x1 - x0, t);
      quad((x0 + x1) / 2, z1 - t / 2, x1 - x0, t);
      quad(x0 + t / 2, (z0 + z1) / 2, t, z1 - z0);
      quad(x1 - t / 2, (z0 + z1) / 2, t, z1 - z0);
      // Letter from a 3x5 pixel font, 0.8 m pixels, readable from the south.
      const glyph = LETTERS[s.name];
      if (!glyph) continue;
      const px = 0.8;
      // Put it on open floor: the site cell nearest the center that isn't cover.
      const spot = this.openSpotNear(s);
      glyph.forEach((row, gy) => {
        [...row].forEach((ch, gx) => {
          if (ch === '#') quad(spot.x + (gx - 1) * px, spot.z + (gy - 2) * px, px, px);
        });
      });
    }
  }

  openSpotNear(site) {
    let best = site.center;
    let bestD = Infinity;
    for (let cz = site.z0 + 1; cz < site.z1; cz++) {
      for (let cx = site.x0 + 1; cx < site.x1; cx++) {
        // the 3x3 block around it must be open so the letter isn't under a crate
        let clear = true;
        for (let dz = -1; dz <= 1 && clear; dz++) for (let dx = -1; dx <= 1; dx++) if (this.isSolid(cx + dx, cz + dz)) clear = false;
        if (!clear) continue;
        const p = this.cellToWorld(cx, cz);
        const d = p.distanceToSquared(site.center);
        if (d < bestD) [best, bestD] = [p, d];
      }
    }
    return best;
  }

  dispose() {
    this.game.scene.remove(this.group);
    this.group.traverse((o) => o.geometry?.dispose());
    for (const m of this.materials.values()) m.dispose();
  }
}
