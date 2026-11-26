import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { Entity } from './Entity.js';
import { Viewmodel } from './Viewmodel.js';
import { Weapon, isBackstab } from '../weapons/Weapon.js';
import { WEAPONS } from '../weapons/definitions.js';
import { BTN, runCmd, patternScale, aimDirection } from '../shared/pawn.js';

// The local player: mouse look, WASD movement, jump, crouch, walk, and
// weapon handling. Drives game.camera directly.
//
// Every logic tick turns the keyboard / mouse into a command (buildCmd) and
// runs it through the shared player simulation (shared/pawn.js), the same
// code the server runs. Online, the command is also sent to the server and
// kept for prediction (net/OnlineSession.js).
//
// Controls: WASD (or arrows) move, Space jump, Ctrl (or C) crouch, Shift walk,
//           LMB fire, RMB aim down sights, R reload, 1-4 or wheel switch,
//           Q knife (again: back to the last gun), E plant / defuse (bomb mode).

const SLOT_KEYS = ['Digit1', 'Digit2', 'Digit3', 'Digit4'];

export class Player extends Entity {
  constructor(game) {
    const cfg = CONFIG.player;
    super(game, { name: 'You', team: CONFIG.teams.player, maxHealth: cfg.maxHealth, radius: cfg.radius, height: cfg.height });
    this.camera = game.camera;
    this.pitch = 0;
    this.crouching = false;
    this.frozen = false; // online freeze time: can look and switch, not move or shoot
    this.eyeHeight = cfg.height - cfg.eyeOffset; // camera height (eases when crouching)
    this.deathTime = 0;
    this.adsT = 0; // 0 = hip fire, 1 = fully aimed down sights
    this.kick = { x: 0, y: 0 }; // recoil turn still easing into yaw/pitch (radians, x right / y up)
    this.smooth = new THREE.Vector3(); // prediction correction still being blended out of the camera
    this.net = null; // OnlineSession while in an online match
    this.seq = 0; // command number
    this.spawnId = 0; // which life this is (online: set by the server)
    this.stepDt = 0;
    this.useBlocks = false; // bomb mode: holding E roots you (shared/pawn.js)
    this.using = false; // E held this tick (plant / defuse)

    this.weapons = cfg.loadout.map((id) => new Weapon(WEAPONS[id]));
    for (const w of this.weapons) w.notify = (type) => game.events.emit(type, { owner: this, weapon: w.def });
    this.weaponIndex = 0;
    this.lastWeaponIndex = 0;
    this.viewmodel = new Viewmodel(game);
    this.viewmodel.setWeapon(this.weapon.def);

    // Client-side reactions to the shared simulation.
    this.hooks = {
      moved: (r) => {
        if (r.jumped) this.game.input.consumePress('Space'); // a tap can't jump twice
        // Running is loud; walking (Shift) and crouching are silent.
        this.footsteps(this.stepDt, { quiet: r.quiet, wasOnGround: r.wasOnGround, fallSpeed: r.fallSpeed });
      },
      switched: () => this.viewmodel.setWeapon(this.weapon.def),
      dryFire: (pressed) => pressed && this.game.audio.beep(300, 0.05, 0.2),
      fired: (result, w) => {
        if (w.def.melee) {
          this.viewmodel.onFire({ backstab: result.backstab });
          return;
        }
        // View follows recoil: this shot's pattern step turns the view for good.
        if (this.recoilView) {
          this.kick.x += result.kick.x;
          this.kick.y += result.kick.y;
        }
        if (this.infiniteAmmo) w.ammo = w.def.magSize;
        this.viewmodel.onFire();
      },
    };
  }

  get weapon() {
    return this.weapons[this.weaponIndex];
  }

  // "View follows recoil" setting: the whole view turns with the spray
  // pattern and the crosshair stays centered on where shots go.
  get recoilView() {
    return !!this.game.settings.get('recoilView');
  }

  // Practice-only cheats (the server ignores them).
  get infiniteAmmo() {
    return !this.net && !!this.game.settings.get('infiniteAmmo');
  }

  // The world point that lines up on screen with the viewmodel's barrel tip
  // (the gun is drawn with its own camera), so tracers leave the visible
  // muzzle: off to the side from the hip, near the center when aiming.
  getMuzzlePosition() {
    const cam = this.camera;
    const m = this.viewmodel.muzzleScreen();
    if (!m) return this.eyePosition;
    cam.updateMatrixWorld();
    const ty = Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2) * m.depth;
    return new THREE.Vector3(m.ndc.x * ty * cam.aspect, m.ndc.y * ty, -m.depth).applyMatrix4(cam.matrixWorld);
  }

  get horizontalSpeed() {
    return Math.hypot(this.velocity.x, this.velocity.z);
  }

  // Angle (radians) between the crosshair and where the next shot will go.
  // The HUD circle is drawn at exactly this radius.
  currentSpread() {
    if (this.recoilView) return 0; // the next shot always goes to the crosshair
    const o = this.weapon.nextOffset(patternScale(this));
    return Math.hypot(o.x, o.y);
  }

  // "Invincible" setting (practice): hits still flash the screen but deal no damage.
  takeDamage(amount, info) {
    if (this.net) return; // online, the server decides
    if (this.game.settings.get('invincible')) amount = 0;
    super.takeDamage(amount, info);
  }

  spawn(position, yaw = 0) {
    const cfg = CONFIG.player;
    this.position.copy(position);
    this.resetPath(); // teleport: don't slide from the old spot
    this.velocity.set(0, 0, 0);
    this.smooth.set(0, 0, 0);
    this.yaw = yaw;
    this.pitch = 0;
    this.health = this.maxHealth;
    this.alive = true;
    this.onGround = false;
    this.crouching = false;
    this.height = cfg.height;
    this.eyeHeight = cfg.height - cfg.eyeOffset;
    this.deathTime = 0;
    this.adsT = 0;
    this.kick = { x: 0, y: 0 };
    for (const w of this.weapons) w.reset();
    this.weaponIndex = 0;
    this.lastWeaponIndex = 0;
    this.backstabReady = false;
    this.viewmodel.setWeapon(this.weapon.def);
    this.viewmodel.setVisible(true);
    this.viewmodel.update(0);
    this.updateCamera(0);
  }

  // Game logic, once per logic tick: input -> command -> shared simulation.
  update(dt) {
    if (!this.alive) this.deathTime += dt;
    else this.look();
    const cmd = this.buildCmd();
    this.using = this.alive && !!(cmd.buttons & BTN.USE);
    this.stepDt = dt;
    runCmd(this, cmd, dt, this.game, this.hooks);
    this.net?.onLocalCmd(cmd);
    if (!this.alive) return;
    if (this.infiniteAmmo) this.refillAmmo();
    if (this.game.tickStart) this.backstabReady = this.checkBackstab();
  }

  // This tick's command from the keyboard and mouse. Actions (fire, reload,
  // switch) only on a tick's first step, so slow ticks allow one per tick.
  buildCmd() {
    const input = this.game.input;
    const down = (...codes) => codes.some((c) => input.isDown(c));
    let b = 0;
    // Arrow keys move too. Many gaming keyboards have an Fn+W toggle that
    // swaps WASD with the arrows, so with it on, W/A/S/D send arrow keys
    // while every other key (Q, 1-4, Space, Tab) works as normal.
    if (down('KeyW', 'ArrowUp')) b |= BTN.FORWARD;
    if (down('KeyS', 'ArrowDown')) b |= BTN.BACK;
    if (down('KeyA', 'ArrowLeft')) b |= BTN.LEFT;
    if (down('KeyD', 'ArrowRight')) b |= BTN.RIGHT;
    // Jump on a hold, or on a tap remembered since the last tick.
    if (down('Space') || input.wasPressed('Space')) b |= BTN.JUMP;
    // Crouch on Ctrl (C also works). Note: in a window, Ctrl+W is the
    // browser's close-tab shortcut and pages can't block it; the "Leave
    // site?" prompt catches it (CONFIG.input.fullscreen locks it out).
    if (down('ControlLeft', 'ControlRight', 'KeyC')) b |= BTN.CROUCH;
    if (down('ShiftLeft', 'ShiftRight')) b |= BTN.WALK;
    if (this.recoilView) b |= BTN.RECOIL_VIEW;
    if (input.isMouseDown(2)) b |= BTN.ADS;
    if (down('KeyE')) b |= BTN.USE;

    let slot = this.weaponIndex;
    if (this.game.tickStart && this.alive) {
      SLOT_KEYS.forEach((key, i) => input.wasPressed(key) && (slot = i));
      if (input.wheel) slot = (slot + input.wheel + this.weapons.length * 4) % this.weapons.length;
      if (input.wasPressed('KeyQ')) {
        const knife = this.weapons.findIndex((wp) => wp.def.melee);
        if (knife >= 0) slot = this.weaponIndex === knife ? this.lastWeaponIndex : knife;
      }
      if (input.isMouseDown(0)) b |= BTN.FIRE;
      if (input.wasMousePressed(0)) b |= BTN.FIRE_PRESS; // a click counts even if released before its tick
      if (input.wasPressed('KeyR')) b |= BTN.RELOAD;
    }
    return {
      seq: ++this.seq,
      buttons: b,
      // Rounded to what the wire carries so prediction matches the server exactly.
      yaw: Math.fround(this.yaw),
      pitch: Math.fround(this.pitch),
      slot,
      spawnId: this.spawnId,
      viewTick: this.net?.viewTick ?? 0,
    };
  }

  // Every rendered frame: mouse look and ADS stay smooth even with slow
  // ticks; the camera slides between tick positions.
  frame(dt, alpha) {
    if (this.alive) {
      this.look();
      this.updateAim(dt);
    }
    this.updateCamera(dt, alpha);
    if (!this.alive) return;
    this.viewmodel.update(dt, {
      speed: this.horizontalSpeed,
      onGround: this.onGround,
      reloadProgress: this.weapon.reloadProgress,
      ads: this.adsT,
      backstabReady: this.backstabReady,
    });
  }

  aimDirection() {
    return aimDirection(this.yaw, this.pitch);
  }

  // Knife out and an enemy's back in reach: the knife raises, ready to stab.
  checkBackstab() {
    const w = this.weapon;
    if (!w.def.melee || !this.alive) return false;
    const dir = this.aimDirection();
    const { hit } = w.meleeTrace(this.game, this, this.eyePosition, dir);
    return !!(hit?.entity?.alive && isBackstab(this.position, dir, hit.entity));
  }

  look() {
    const { x, y } = this.game.input.consumeMouse();
    // Slow the mouse down while zoomed so aim feels consistent.
    const s = CONFIG.input.mouseSensitivity * this.game.settings.get('sensitivity') * (this.camera.fov / CONFIG.render.fov);
    this.yaw -= x * s;
    this.pitch = THREE.MathUtils.clamp(this.pitch - y * s, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);
  }

  // Right mouse held = aim down sights (not while reloading).
  updateAim(dt) {
    const want = this.game.input.isMouseDown(2) && !this.weapon.reloading && !this.weapon.def.melee;
    const step = dt / CONFIG.player.adsTime;
    this.adsT = Math.min(1, Math.max(0, this.adsT + (want ? step : -step)));
  }

  // "Unlimited ammo" setting: mags never run down, so there's nothing to reload.
  refillAmmo() {
    for (const w of this.weapons) {
      w.cancelReload();
      w.ammo = w.def.magSize;
      w.reserve = w.def.reserve;
    }
  }

  // Online: the server corrected our position. Shift the drawn path and blend
  // the difference out over a few frames instead of snapping.
  applyCorrection(delta) {
    if (delta.lengthSq() > 4) {
      this.smooth.set(0, 0, 0);
      this.resetPath();
      return;
    }
    this.smooth.add(delta);
    for (const p of this.trail) p.sub(delta);
  }

  updateCamera(dt, alpha = 1) {
    const cfg = CONFIG.player;
    const target = this.alive ? this.height - cfg.eyeOffset : 0.3;
    this.eyeHeight += (target - this.eyeHeight) * Math.min(1, dt * (this.alive ? 14 : 5));

    this.renderPosition(alpha, this.camera.position);
    this.smooth.multiplyScalar(Math.exp(-15 * dt));
    this.camera.position.add(this.smooth);
    this.camera.position.y += this.eyeHeight;
    const roll = this.alive ? 0 : Math.min(this.deathTime * 2, 1) * 0.6;

    // Recoil kick: each shot's pattern step eases into the real facing
    // (yaw/pitch) over a few frames. It's permanent: when you stop firing
    // you stay where the recoil took you, nothing drifts back.
    if (this.kick.x || this.kick.y) {
      const k = 1 - Math.exp(-CONFIG.player.recoilViewSpeed * dt);
      const dx = this.kick.x * k;
      const dy = this.kick.y * k;
      this.yaw -= dx;
      this.pitch = THREE.MathUtils.clamp(this.pitch + dy, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);
      this.kick.x -= dx;
      this.kick.y -= dy;
      if (Math.abs(this.kick.x) + Math.abs(this.kick.y) < 1e-6) this.kick.x = this.kick.y = 0;
    }
    this.camera.rotation.set(this.pitch, this.yaw, roll);

    const zoom = 1 + ((this.weapon.def.adsZoom ?? 1) - 1) * this.adsT;
    const fov = CONFIG.render.fov / zoom;
    if (Math.abs(this.camera.fov - fov) > 1e-3) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }

  onDeath() {
    this.adsT = 0;
    this.viewmodel.setVisible(false);
    this.weapon.cancelReload();
  }
}
