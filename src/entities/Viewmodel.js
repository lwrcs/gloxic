import * as THREE from 'three';
import { CONFIG } from '../config.js';

// The first-person gun. It lives in game.viewScene (drawn on top of the
// world) and animates bob, recoil kick, weapon raise, reload dip and the
// blend between hip and aim-down-sights poses.
// Models are simple boxes built from each weapon's `model` stats; swap
// buildModel() for a loaded GLTF later.

const SIGHT_TOP = 0.075; // height of the sight line above the receiver center
const HIP_POS = new THREE.Vector3(0.22, -0.2, -0.52);
const ADS_POS = new THREE.Vector3(0, -SIGHT_TOP, -0.42);
const KNIFE_POS = new THREE.Vector3(0.2, -0.19, -0.4);
const KNIFE_SWING_TIME = 0.3;

// Knife swipe animations. Each returns an offset pose for t = 0..1; `w` is
// the out-and-back weight (0 at both ends, so every swing returns to idle).
//   0 right-to-left slash, 1 left-to-right slash, 2 jab, 3 backstab stab
const KNIFE_SWINGS = [
  (t, w) => ({ x: w * (0.14 - 0.34 * t), y: w * 0.04, z: -w * 0.12, rx: -w * 0.1, ry: w * (0.7 - 1.6 * t), rz: -w * 0.9 }),
  (t, w) => ({ x: w * (-0.2 + 0.34 * t), y: w * 0.02, z: -w * 0.12, rx: -w * 0.1, ry: w * (-0.9 + 1.6 * t), rz: w * 0.9 }),
  (t, w) => ({ x: -w * 0.04, y: w * 0.02, z: -w * 0.22, rx: w * 0.15, ry: 0, rz: 0 }),
  (t, w) => ({ x: -w * 0.02, y: -w * 0.24, z: -w * 0.16, rx: -w * 0.7, ry: 0, rz: 0 }),
];
// Raised "ready to backstab" pose (blended in when one is possible).
const KNIFE_READY = { x: -0.07, y: 0.15, z: 0.05, rx: -0.95, ry: 0.15, rz: 0.1 };

export class Viewmodel {
  constructor(game) {
    this.viewCamera = game.viewCamera;
    this.root = new THREE.Group();
    game.viewScene.add(this.root);
    this.models = {};
    this.current = null;
    this.material = new THREE.MeshLambertMaterial({ color: 0x555555 });
    this.kick = 0;
    this.raise = 1;
    this.bobTime = 0;
    this.flashTime = 0;
    this.swingT = 1; // knife swing progress (1 = idle)
    this.swingVariant = 0;
    this.ready = 0; // 0..1 blend into the backstab-ready pose

    // No outline tag: it shows up as a bright dithered burst.
    this.flash = new THREE.Mesh(
      new THREE.PlaneGeometry(0.1, 0.1),
      new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }),
    );
    this.flash.visible = false;
  }

  buildModel(def) {
    if (def.model?.knife) return this.buildKnife();
    const { length = 0.5, barrel = 0.03, mag = true, stock = false, pump = false } = def.model ?? {};
    const g = new THREE.Group();
    const box = (w, h, d, x, y, z) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), this.material);
      m.position.set(x, y, z);
      m.userData.outline = CONFIG.outlines.weapon;
      g.add(m);
      return m;
    };

    const barrelLen = length * 0.5;
    const barrelZ = -length - barrelLen / 2;
    const barrelTop = 0.015 + barrel / 2;
    box(0.07, 0.09, length, 0, 0, -length / 2); // receiver
    box(barrel, barrel, barrelLen, 0, 0.015, barrelZ); // barrel
    if (mag) box(0.05, length > 0.3 ? 0.16 : 0.12, 0.06, 0, -0.1, -length * 0.35); // mag / grip
    if (stock) box(0.06, 0.1, 0.2, 0, -0.03, 0.08);
    if (pump) box(0.06, 0.05, barrelLen * 0.6, 0, -0.03, barrelZ + barrelLen * 0.15);
    if (!mag) box(0.05, 0.12, 0.06, 0, -0.09, -0.05); // grip

    // Iron sights: a notched rear sight and a front post, both topping out
    // at SIGHT_TOP so aiming lines them up with the screen center.
    box(0.006, 0.03, 0.012, -0.011, 0.06, -0.03);
    box(0.006, 0.03, 0.012, 0.011, 0.06, -0.03);
    const postH = SIGHT_TOP - barrelTop;
    box(0.008, postH, 0.01, 0, barrelTop + postH / 2, -length - barrelLen + 0.01);

    g.userData.muzzle = new THREE.Vector3(0, 0.015, -length - barrelLen - 0.03);
    g.visible = false;
    this.root.add(g);
    return g;
  }

  buildKnife() {
    const g = new THREE.Group();
    const box = (w, h, d, x, y, z) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), this.material);
      m.position.set(x, y, z);
      m.userData.outline = CONFIG.outlines.weapon;
      g.add(m);
    };
    box(0.03, 0.036, 0.12, 0, 0, 0); // handle
    box(0.06, 0.014, 0.014, 0, 0, -0.065); // guard
    box(0.008, 0.034, 0.2, 0, 0.004, -0.17); // blade
    box(0.006, 0.018, 0.05, 0, 0.012, -0.29); // tip
    g.userData.muzzle = new THREE.Vector3(0, 0.01, -0.32);
    g.rotation.set(0.1, 0.25, -0.35); // idle: blade forward, canted
    g.visible = false;
    this.root.add(g);
    return g;
  }

  setWeapon(def) {
    if (!this.models[def.id]) this.models[def.id] = this.buildModel(def);
    for (const m of Object.values(this.models)) m.visible = false;
    const model = this.models[def.id];
    model.visible = true;
    model.add(this.flash);
    this.flash.position.copy(model.userData.muzzle);
    this.current = def;
    this.raise = 0;
  }

  // Where the barrel tip is on screen: { ndc: (x, y) in -1..1, depth: metres
  // in front of the view camera }. Follows bob, kick and the hip->ADS blend.
  muzzleScreen() {
    const model = this.current && this.models[this.current.id];
    if (!model) return null;
    model.updateWorldMatrix(true, false);
    this.viewCamera.updateMatrixWorld();
    const p = model.userData.muzzle.clone().applyMatrix4(model.matrixWorld).applyMatrix4(this.viewCamera.matrixWorldInverse);
    const depth = -p.z;
    const ndc = p.applyMatrix4(this.viewCamera.projectionMatrix);
    return { ndc: new THREE.Vector2(ndc.x, ndc.y), depth };
  }

  // Guns: recoil kick + muzzle flash. Knife: start a swipe (backstab uses
  // the stab animation; otherwise a random slash/jab, never the same twice).
  onFire({ backstab = false } = {}) {
    if (this.current?.melee) {
      let v = backstab ? 3 : Math.floor(Math.random() * 3);
      if (!backstab && v === this.swingVariant) v = (v + 1) % 3;
      this.swingVariant = v;
      this.swingT = 0;
      return v;
    }
    this.kick = 1;
    this.flashTime = 0.04;
    this.flash.rotation.z = Math.random() * Math.PI;
  }

  setVisible(v) {
    this.root.visible = v;
  }

  // state: { speed (m/s), onGround, reloadProgress (0..1), ads (0..1),
  //          backstabReady (knife: raise into the backstab pose) }
  update(dt, { speed = 0, onGround = true, reloadProgress = 0, ads = 0, backstabReady = false } = {}) {
    if (this.current?.melee) {
      this.updateKnife(dt, speed, onGround, backstabReady);
      return;
    }
    this.kick = Math.max(0, this.kick - dt * 12);
    this.raise = Math.min(1, this.raise + dt * 15); // near-instant swaps
    this.flashTime -= dt;
    this.flash.visible = this.flashTime > 0;

    const bobAmount = (onGround ? Math.min(speed / 6, 1) : 0) * (1 - ads * 0.85) * CONFIG.viewmodel.bob;
    this.bobTime += dt * (4 + speed * 1.4) * (bobAmount > 0 ? 1 : 0);
    const dip = Math.sin(reloadProgress * Math.PI);
    const kickZ = this.kick * (ads > 0.5 ? 0.03 : 0.05);

    this.root.position.lerpVectors(HIP_POS, ADS_POS, ads);
    this.root.position.x += Math.sin(this.bobTime) * 0.012 * bobAmount;
    this.root.position.y += Math.abs(Math.cos(this.bobTime)) * 0.01 * bobAmount - (1 - this.raise) * 0.3 - dip * 0.12;
    this.root.position.z += kickZ;
    this.root.rotation.set(this.kick * 0.06 * (1 - ads * 0.6) - dip * 0.8, 0, dip * 0.3);
  }

  updateKnife(dt, speed, onGround, backstabReady) {
    this.raise = Math.min(1, this.raise + dt * 15);
    this.flash.visible = false;
    this.swingT = Math.min(1, this.swingT + dt / KNIFE_SWING_TIME);
    // Stay raised through the stab itself.
    const wantReady = backstabReady || (this.swingVariant === 3 && this.swingT < 1);
    this.ready += ((wantReady ? 1 : 0) - this.ready) * Math.min(1, dt * 12);

    const bobAmount = (onGround ? Math.min(speed / 6, 1) : 0) * CONFIG.viewmodel.bob;
    this.bobTime += dt * (4 + speed * 1.4) * (bobAmount > 0 ? 1 : 0);

    const t = this.swingT;
    const w = t < 1 ? Math.sin(Math.PI * t) : 0;
    const s = KNIFE_SWINGS[this.swingVariant](t, w);
    const r = this.ready;
    this.root.position.set(
      KNIFE_POS.x + KNIFE_READY.x * r + s.x + Math.sin(this.bobTime) * 0.012 * bobAmount,
      KNIFE_POS.y + KNIFE_READY.y * r + s.y + Math.abs(Math.cos(this.bobTime)) * 0.01 * bobAmount - (1 - this.raise) * 0.3,
      KNIFE_POS.z + KNIFE_READY.z * r + s.z,
    );
    this.root.rotation.set(KNIFE_READY.rx * r + s.rx, KNIFE_READY.ry * r + s.ry, KNIFE_READY.rz * r + s.rz);
  }
}
