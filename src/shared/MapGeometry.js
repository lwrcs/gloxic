import * as THREE from 'three';
import { segmentClear } from './raycast.js';

// The map as pure data: grid, solid boxes, spawns, pathfinding and line of
// sight. No rendering, so the server runs the exact same level as the
// client (world/World.js adds the meshes and lights on top).

const DIRS = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
];

export class MapGeometry {
  constructor(def) {
    this.def = def;
    this.cell = def.cellSize;
    this.boxes = []; // { x, y, z, w, h, d, tile } (center + size)
    this.colliders = []; // THREE.Box3[] for physics and hitscan
    this.spawns = {}; // team -> Vector3[]
    this.parse();
    this.buildBoxes();
  }

  parse() {
    const rows = this.def.layout;
    this.depth = rows.length;
    this.width = Math.max(...rows.map((r) => r.length));
    this.grid = rows.map((r) => r.padEnd(this.width, '#'));
    this.halfW = (this.width * this.cell) / 2;
    this.halfD = (this.depth * this.cell) / 2;
    for (let z = 0; z < this.depth; z++) {
      for (let x = 0; x < this.width; x++) {
        const team = this.def.spawns?.[this.grid[z][x]];
        if (team) (this.spawns[team] ??= []).push(this.cellToWorld(x, z));
      }
    }
  }

  buildBoxes() {
    // Floor: one big slab with its top at y = 0.
    this.addBox(0, -0.5, 0, this.width * this.cell, 1, this.depth * this.cell, this.def.floor);
    // Merge horizontal runs of the same tile into one box each.
    for (let z = 0; z < this.depth; z++) {
      let x = 0;
      while (x < this.width) {
        const ch = this.grid[z][x];
        const tile = this.def.tiles[ch];
        if (!tile?.solid) {
          x++;
          continue;
        }
        let end = x + 1;
        while (end < this.width && this.grid[z][end] === ch) end++;
        const run = end - x;
        const a = this.cellToWorld(x, z);
        this.addBox(a.x + ((run - 1) * this.cell) / 2, tile.height / 2, a.z, run * this.cell, tile.height, this.cell, tile);
        x = end;
      }
    }
  }

  addBox(x, y, z, w, h, d, tile) {
    this.boxes.push({ x, y, z, w, h, d, tile });
    this.colliders.push(
      new THREE.Box3(new THREE.Vector3(x - w / 2, y - h / 2, z - d / 2), new THREE.Vector3(x + w / 2, y + h / 2, z + d / 2)),
    );
  }

  cellToWorld(cx, cz) {
    return new THREE.Vector3((cx + 0.5) * this.cell - this.halfW, 0, (cz + 0.5) * this.cell - this.halfD);
  }

  worldToCell(x, z) {
    return { cx: Math.floor((x + this.halfW) / this.cell), cz: Math.floor((z + this.halfD) / this.cell) };
  }

  isSolid(cx, cz) {
    if (cx < 0 || cz < 0 || cx >= this.width || cz >= this.depth) return true;
    return !!this.def.tiles[this.grid[cz][cx]]?.solid;
  }

  // A random open (walkable) cell center, optionally passing test(point).
  randomOpenPoint(test = () => true, tries = 60) {
    for (let i = 0; i < tries; i++) {
      const cx = Math.floor(Math.random() * this.width);
      const cz = Math.floor(Math.random() * this.depth);
      if (this.isSolid(cx, cz)) continue;
      const p = this.cellToWorld(cx, cz);
      if (test(p)) return p;
    }
    return null;
  }

  getSpawns(team) {
    return this.spawns[team] ?? [new THREE.Vector3()];
  }

  hasLineOfSight(from, to) {
    return segmentClear(from, to, this.colliders);
  }

  // Breadth-first search over the grid. Returns world-space waypoints
  // (cell centers) from just after `from` up to `to`, or null.
  findPath(from, to) {
    const s = this.worldToCell(from.x, from.z);
    const g = this.worldToCell(to.x, to.z);
    if (this.isSolid(g.cx, g.cz)) return null;
    const W = this.width;
    const start = s.cz * W + s.cx;
    const goal = g.cz * W + g.cx;
    const prev = new Int32Array(W * this.depth).fill(-1);
    prev[start] = start;
    const queue = [start];
    for (let head = 0; head < queue.length; head++) {
      const cur = queue[head];
      if (cur === goal) break;
      const cx = cur % W;
      const cz = (cur - cx) / W;
      for (const [dx, dz] of DIRS) {
        const nx = cx + dx;
        const nz = cz + dz;
        if (this.isSolid(nx, nz)) continue;
        if (dx && dz && (this.isSolid(cx + dx, cz) || this.isSolid(cx, cz + dz))) continue; // no corner cutting
        const n = nz * W + nx;
        if (prev[n] !== -1) continue;
        prev[n] = cur;
        queue.push(n);
      }
    }
    if (prev[goal] === -1) return null;
    const path = [];
    for (let c = goal; c !== start; c = prev[c]) path.push(this.cellToWorld(c % W, Math.floor(c / W)));
    return path.reverse();
  }
}
