import * as THREE from 'three';
import { BOMB } from '../shared/bomb.js';

// Client-side look and sound of the bomb (online and practice): the bomb
// lying on the ground or planted (with a blinking light and a beep that
// speeds up as the fuse runs down), and the blast. Sessions call sync()
// with the bomb's public state and update() every frame.

const bodyGeo = new THREE.BoxGeometry(0.42, 0.22, 0.3);
const ledGeo = new THREE.BoxGeometry(0.08, 0.04, 0.08);
const blastGeo = new THREE.SphereGeometry(1, 16, 12);

export class BombView {
  constructor(game) {
    this.game = game;
    this.root = new THREE.Group();
    const body = new THREE.Mesh(bodyGeo, new THREE.MeshLambertMaterial({ color: 0x333333 }));
    body.position.y = 0.11;
    body.castShadow = true;
    body.userData.outline = 1;
    this.ledMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.led = new THREE.Mesh(ledGeo, this.ledMat);
    this.led.position.set(0.1, 0.24, 0);
    this.root.add(body, this.led);
    this.root.visible = false;
    game.scene.add(this.root);
    this.blast = new THREE.Mesh(blastGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 }));
    this.blast.visible = false;
    game.scene.add(this.blast);
    this.blastT = 0;
    this.state = 'none';
    this.fuseLeft = 0;
    this.beepTimer = 0;
  }

  // b: { state, pos: [x, y, z] | null, fuse }
  sync(b) {
    if (!b) return;
    const prev = this.state;
    this.state = b.state;
    if (b.pos) this.root.position.set(b.pos[0], b.pos[1], b.pos[2]);
    this.root.visible = b.state === 'dropped' || b.state === 'planted' || b.state === 'defused';
    if (b.state === 'planted' && prev !== 'planted') {
      this.fuseLeft = b.fuse || BOMB.fuse;
      this.beepTimer = 0;
    }
    if (b.state === 'exploded' && prev !== 'exploded') this.explode();
  }

  explode() {
    this.root.visible = false;
    this.blast.position.copy(this.root.position);
    this.blast.visible = true;
    this.blastT = 0;
    const position = this.root.position.clone();
    this.game.audio.gunshot({ volume: 3, pitch: 0.3, position });
    this.game.audio.gunshot({ volume: 2, pitch: 0.2, position });
    this.game.events.emit('noise', { position, radius: 80, source: null, kind: 'shot' });
  }

  update(dt) {
    if (this.blast.visible) {
      this.blastT += dt;
      const k = this.blastT / 0.7;
      this.blast.scale.setScalar(1 + k * BOMB.blastRadius * 0.5);
      this.blast.material.opacity = Math.max(0, 0.9 * (1 - k));
      if (k >= 1) this.blast.visible = false;
    }
    if (this.state !== 'planted') {
      this.ledMat.color.setScalar(this.state === 'defused' ? 0.2 : 1);
      return;
    }
    this.fuseLeft = Math.max(0, this.fuseLeft - dt);
    // Beeps: once a second at first, faster and faster near the end.
    const interval = Math.max(0.1, Math.min(1, this.fuseLeft / BOMB.fuse) * 1.0);
    this.beepTimer -= dt;
    if (this.beepTimer <= 0) {
      this.beepTimer = interval;
      const d = this.game.camera.position.distanceTo(this.root.position);
      const vol = 0.25 / (1 + d / 8);
      if (vol > 0.01) this.game.audio.beep(this.fuseLeft < 5 ? 1700 : 1400, 0.06, vol);
      this.ledOn = 0.08;
    }
    this.ledOn = (this.ledOn ?? 0) - dt;
    this.ledMat.color.setScalar(this.ledOn > 0 ? 1 : 0.15);
  }

  dispose() {
    this.game.scene.remove(this.root, this.blast);
  }
}

// The objective line under the crosshair and the plant / defuse bar, from
// the local player's point of view.
//   role: 'attack' | 'defend'; bomb: public state; meId: how the carrier
//   is matched; site: site the player stands in; action: { kind, progress }
export function bombObjective({ role, bomb, isCarrier, alive, site, action, live }) {
  if (!bomb || !role) return null;
  if (action) return { text: action.kind === 'plant' ? 'Planting the bomb...' : 'Defusing...', progress: action.progress };
  if (!alive) return { text: role === 'attack' ? 'Attacking' : 'Defending' };
  const s = bomb.state;
  if (role === 'attack') {
    if (isCarrier) {
      if (!live) return { text: 'You have the bomb' };
      return { text: site ? `Site ${site}: hold E to plant` : 'You have the bomb: plant it at site A or B' };
    }
    if (s === 'dropped') return { text: 'The bomb was dropped: pick it up' };
    if (s === 'planted') return { text: `Defend the bomb at site ${bomb.site}` };
    return { text: 'Attack: escort the bomb to site A or B' };
  }
  if (s === 'planted') return { text: `Bomb planted at site ${bomb.site}: hold E on it to defuse` };
  return { text: 'Defend sites A and B' };
}
