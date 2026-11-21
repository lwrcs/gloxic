import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { Entity } from './Entity.js';
import { BODY_PARTS, STAND_HEIGHT } from '../shared/hitboxes.js';
import { FLAG } from '../shared/protocol.js';
import { botMaterial } from './Bot.js';

// Another player in an online match. Purely a puppet: every frame it takes
// its state from the session's snapshot buffer, interpolated at the
// session's render time (a little in the past, so it's smooth). Its
// hitboxes follow what's drawn, which is what the server rewinds to when
// you shoot. Damage is the server's call, so takeDamage does nothing here.

const partGeo = Object.fromEntries(BODY_PARTS.map((b) => [b.part, new THREE.BoxGeometry(b.w, b.h, b.d)]));
const gunGeo = new THREE.BoxGeometry(0.07, 0.09, 0.6);

export class RemotePlayer extends Entity {
  constructor(game, session, info) {
    const cfg = CONFIG.player;
    super(game, { name: info.name, team: info.team, maxHealth: cfg.maxHealth, radius: cfg.radius, height: cfg.height });
    this.id = info.id;
    this.session = session;
    this.alive = false;
    this.crouching = false;
    this.quiet = false;
    this.deathTime = 0;
    this.lastPos = null;
    this.vy = 0;
    this.buildModel();
    this.tag = document.createElement('div');
    this.tag.className = 'nametag';
    this.setInfo(info);
    document.body.appendChild(this.tag);
  }

  setInfo(info) {
    this.name = info.name;
    this.team = info.team;
    this.tag.textContent = info.name;
    const friend = this.team === this.game.player.team;
    this.tag.classList.toggle('friend', friend);
    for (const m of this.parts) m.userData.outline = friend ? 0.45 : CONFIG.outlines.enemy;
  }

  buildModel() {
    this.root = new THREE.Group();
    this.parts = [];
    this.meshes = {};
    const add = (g, y, z = 0) => {
      const m = new THREE.Mesh(g, botMaterial);
      m.position.set(0, y, z);
      m.castShadow = true;
      this.root.add(m);
      this.parts.push(m);
      return m;
    };
    for (const b of BODY_PARTS) this.meshes[b.part] = add(partGeo[b.part], b.y);
    this.gun = add(gunGeo, 1.25, -0.35);
    this.gun.position.x = 0.2;
    this.root.visible = false;
    this.game.scene.add(this.root);
  }

  takeDamage() {}

  getMuzzlePosition() {
    this.root.updateMatrixWorld();
    return new THREE.Vector3(0, 0, -0.3).applyMatrix4(this.gun.matrixWorld);
  }

  frame(dt) {
    const s = this.session.sample(this.id);
    if (!s) {
      this.root.visible = false;
      this.tag.style.display = 'none';
      return;
    }
    const wasAlive = this.alive;
    this.alive = !!(s.flags & FLAG.ALIVE);
    this.crouching = !!(s.flags & FLAG.CROUCH);
    this.quiet = !!(s.flags & FLAG.QUIET);
    this.height = this.crouching ? CONFIG.player.crouchHeight : CONFIG.player.height;
    this.yaw = s.yaw;
    this.position.set(s.position.x, s.position.y, s.position.z);

    // Velocity from the drawn motion (drives footsteps).
    if (this.lastPos && dt > 0 && this.alive && wasAlive) {
      this.velocity.subVectors(this.position, this.lastPos).divideScalar(dt);
      if (this.velocity.lengthSq() > 400) this.velocity.set(0, 0, 0); // teleport
    } else this.velocity.set(0, 0, 0);
    this.lastPos = (this.lastPos ?? new THREE.Vector3()).copy(this.position);
    const wasOnGround = this.onGround;
    const fallSpeed = this.vy;
    this.onGround = !!(s.flags & FLAG.GROUND);
    this.vy = -this.velocity.y;
    if (this.alive && wasAlive) this.footsteps(dt, { quiet: this.quiet, wasOnGround, fallSpeed });

    // Pose: crouch squashes legs and torso, the head drops.
    const k = this.height / STAND_HEIGHT;
    for (const b of BODY_PARTS) {
      const m = this.meshes[b.part];
      if (b.part === 'head') m.position.y = this.height - (STAND_HEIGHT - b.y);
      else {
        m.scale.y = k;
        m.position.y = b.y * k;
      }
    }
    this.gun.position.y = 1.25 * k;

    this.root.visible = true;
    this.root.position.copy(this.position);
    this.root.rotation.set(0, this.yaw, 0);
    if (!this.alive) {
      if (wasAlive) this.deathTime = 0;
      this.deathTime += dt;
      const t = Math.min(1, this.deathTime / 0.4);
      this.root.rotation.x = (-Math.PI / 2) * t * t;
    }
    this.updateTag();
  }

  // Teammates get a name above their head.
  updateTag() {
    const show = this.alive && this.team === this.game.player.team && !this.game.paused;
    if (!show) {
      this.tag.style.display = 'none';
      return;
    }
    const v = new THREE.Vector3(this.position.x, this.position.y + this.height + 0.35, this.position.z).project(this.game.camera);
    if (v.z > 1) {
      this.tag.style.display = 'none';
      return;
    }
    this.tag.style.display = 'block';
    this.tag.style.transform = `translate(${(v.x * 0.5 + 0.5) * window.innerWidth}px, ${(-v.y * 0.5 + 0.5) * window.innerHeight}px) translate(-50%, -100%)`;
  }

  dispose() {
    this.game.scene.remove(this.root);
    this.tag.remove();
  }
}
