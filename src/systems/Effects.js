import * as THREE from 'three';

// Visual and audio feedback: tracers, bullet holes, impact puffs, gunshot /
// knife / footstep sounds. Purely reactive: it listens to 'shot',
// 'footstep' and reload events. Other entities' sounds are placed in 3D
// (see Audio.route); your own play centered.

const MAX_DECALS = 200;
// Bullet hole: a small solid-black disc. It's drawn after the walls
// (renderOrder) and pulled toward the camera (polygonOffset + a small lift
// off the surface) so it always sits in front of the surface it's on. It has
// no outline tag, so it shows as a dither-free black spot.
const decalGeo = new THREE.CircleGeometry(0.045, 12);
const DECAL_LIFT = 0.002; // more lift shows up as an outline at grazing angles
const puffGeo = new THREE.BoxGeometry(0.05, 0.05, 0.05);
const _z = new THREE.Vector3(0, 0, 1);

export class Effects {
  constructor(game) {
    this.game = game;
    this.transients = []; // { object, life, maxLife, update? }
    this.decals = [];
    this.decalMat = new THREE.MeshBasicMaterial({
      color: 0x000000,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
    game.events.on('shot', (e) => this.onShot(e));
    game.events.on('footstep', (e) => this.onFootstep(e));
    // Reload sounds are timed to finish as the reload completes, and are cut
    // off if the reload is cancelled (weapon switch, death, respawn).
    this.reloadSounds = new Map(); // owner -> handle
    game.events.on('reloadStart', (e) => this.onReloadStart(e));
    game.events.on('reloadCancel', ({ owner }) => this.stopReloadSound(owner));
    game.events.on('reloadEnd', ({ owner }) => this.reloadSounds.delete(owner));
    game.events.on('roundStart', () => this.clearDecals());
  }

  onShot({ owner, weapon, origin, pellets, melee, backstab }) {
    if (melee) {
      this.onSwing(owner, pellets[0], backstab);
      return;
    }
    const muzzle = owner.getMuzzlePosition();
    for (const { direction, hit } of pellets) {
      const end = hit ? hit.point : origin.clone().addScaledVector(direction, weapon.range);
      this.tracer(muzzle, end);
      if (hit?.entity) this.puff(hit.point, 0xffffff, 6);
      else if (hit) {
        this.decal(hit.point, hit.normal);
        this.puff(hit.point, 0xaaaaaa, 4);
      }
    }

    // A random sample from the weapon's sound set, else the synthesized shot.
    const snd = weapon.sound ?? {};
    const opts = { volume: snd.volume ?? 1, pitch: snd.pitch ?? 1, position: this.soundPosition(owner) };
    if (!snd.set || !this.game.audio.play(snd.set, opts)) this.game.audio.gunshot(opts);
    // Follow-up sound right after the shot (the shotgun's pump / cock).
    if (snd.after) {
      this.game.audio.play(snd.after, { volume: snd.afterVolume ?? 1, delay: snd.afterDelay ?? 0, position: opts.position });
    }
  }

  // Your own sounds play centered (null); everyone else's come from them.
  soundPosition(owner) {
    return owner === this.game.player ? null : owner.eyePosition;
  }

  // Knife: whoosh variant matching the swipe, then a thud or tick on contact.
  onSwing(owner, { hit }, backstab) {
    const audio = this.game.audio;
    const position = this.soundPosition(owner);
    const variant = owner === this.game.player ? owner.viewmodel.swingVariant : Math.floor(Math.random() * 3);
    audio.whoosh({ variant: backstab ? 3 : variant, position });
    if (!hit) return;
    audio.impact({ kind: hit.entity ? 'flesh' : 'wall', position, volume: backstab ? 1 : 0.7 });
    this.puff(hit.point, hit.entity ? 0xffffff : 0xaaaaaa, hit.entity ? 8 : 3);
  }

  onFootstep({ entity, position, foot = 1, heavy = false, volume = 1 }) {
    const own = entity === this.game.player;
    this.game.audio.footstep({
      position: own ? null : position.clone().setY(position.y + 0.1),
      volume: (own ? 0.28 : 0.9) * volume,
      foot,
      heavy,
    });
  }

  onReloadStart({ owner, weapon }) {
    const snd = weapon.sound;
    if (!snd?.reload) return;
    this.stopReloadSound(owner);
    const handle = this.game.audio.play(snd.reload, {
      volume: snd.reloadVolume ?? 1,
      position: this.soundPosition(owner),
      endIn: weapon.reloadTime,
    });
    if (handle) this.reloadSounds.set(owner, handle);
  }

  stopReloadSound(owner) {
    this.reloadSounds.get(owner)?.stop();
    this.reloadSounds.delete(owner);
  }

  tracer(from, to) {
    const geo = new THREE.BufferGeometry().setFromPoints([from, to]);
    const mat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8 });
    const line = new THREE.Line(geo, mat);
    this.game.scene.add(line);
    this.transients.push({ object: line, life: 0.05, maxLife: 0.05 });
  }

  decal(point, normal) {
    if (!normal) return;
    const m = new THREE.Mesh(decalGeo, this.decalMat);
    m.renderOrder = 1;
    m.position.copy(point).addScaledVector(normal, DECAL_LIFT);
    m.quaternion.setFromUnitVectors(_z, normal);
    this.game.scene.add(m);
    this.decals.push(m);
    if (this.decals.length > MAX_DECALS) this.game.scene.remove(this.decals.shift());
  }

  puff(point, color, count) {
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true });
    for (let i = 0; i < count; i++) {
      const p = new THREE.Mesh(puffGeo, mat);
      p.position.copy(point);
      const vel = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.8, Math.random() - 0.5).multiplyScalar(3);
      this.game.scene.add(p);
      this.transients.push({
        object: p,
        life: 0.35,
        maxLife: 0.35,
        ownsMaterial: i === count - 1,
        update: (dt) => {
          vel.y -= 9 * dt;
          p.position.addScaledVector(vel, dt);
        },
      });
    }
  }

  clearDecals() {
    for (const d of this.decals) this.game.scene.remove(d);
    this.decals = [];
  }

  update(dt) {
    for (let i = this.transients.length - 1; i >= 0; i--) {
      const t = this.transients[i];
      t.life -= dt;
      t.update?.(dt);
      if (t.object.material) t.object.material.opacity = Math.max(0, t.life / t.maxLife);
      if (t.life <= 0) {
        this.game.scene.remove(t.object);
        if (t.object.isLine) t.object.geometry.dispose();
        if (t.object.isLine || t.ownsMaterial) t.object.material.dispose();
        this.transients.splice(i, 1);
      }
    }
  }
}
