import * as THREE from 'three';

// Floating damage numbers. All damage an enemy takes during one game tick
// (one frame when ticks are off) is added up and shown as a single red
// number that pops off the target and drifts away. Headshots get a white
// outline. Damage to the player isn't shown (the screen flash covers that).

const LIFE = 0.9; // seconds on screen
const RISE = 70; // pixels the number travels upward over its life
const _v = new THREE.Vector3();

export class DamageNumbers {
  constructor(game) {
    this.game = game;
    this.pending = new Map(); // target -> { amount, head }
    this.active = []; // { el, anchor, age, vx }

    this.layer = document.createElement('div');
    this.layer.className = 'damage-numbers';
    document.body.appendChild(this.layer);

    game.events.on('damage', (e) => this.onDamage(e));
    game.events.on('tickEnd', () => this.flush());
    game.events.on('roundStart', () => this.clear());
    game.events.on('pause', () => (this.layer.style.display = 'none'));
    game.events.on('resume', () => (this.layer.style.display = ''));
  }

  onDamage({ target, amount, part }) {
    if (target === this.game.player || amount <= 0) return;
    const d = this.pending.get(target) ?? { amount: 0, head: false };
    d.amount += amount;
    d.head ||= part === 'head';
    this.pending.set(target, d);
  }

  // End of a tick: one number per target that took damage.
  flush() {
    for (const [target, d] of this.pending) {
      const anchor = d.head ? target.eyePosition : target.chestPosition;
      anchor.y += 0.25;
      const el = document.createElement('div');
      el.className = d.head ? 'dmg head' : 'dmg';
      el.textContent = Math.round(d.amount);
      this.layer.appendChild(el);
      // Fly off to a random side so stacked hits don't overlap.
      this.active.push({ el, anchor, age: 0, vx: (Math.random() * 2 - 1) * 45 });
    }
    this.pending.clear();
  }

  clear() {
    for (const n of this.active) n.el.remove();
    this.active = [];
    this.pending.clear();
  }

  update(dt) {
    const cam = this.game.camera;
    const w = window.innerWidth;
    const h = window.innerHeight;
    for (let i = this.active.length - 1; i >= 0; i--) {
      const n = this.active[i];
      n.age += dt;
      const t = n.age / LIFE;
      if (t >= 1) {
        n.el.remove();
        this.active.splice(i, 1);
        continue;
      }
      // Stick to the spot in the world, plus a screen-space flight path.
      _v.copy(n.anchor).project(cam);
      if (_v.z > 1) {
        n.el.style.display = 'none';
        continue;
      }
      const x = (_v.x * 0.5 + 0.5) * w + n.vx * t;
      const y = (-_v.y * 0.5 + 0.5) * h - RISE * (1 - (1 - t) * (1 - t)); // ease out
      const pop = t < 0.12 ? 0.6 + (t / 0.12) * 0.6 : 1.2 - Math.min(0.2, (t - 0.12) * 0.8);
      n.el.style.display = 'block';
      n.el.style.opacity = t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4;
      n.el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%) scale(${pop})`;
    }
  }
}
