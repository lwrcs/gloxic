import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { Events } from './Events.js';
import { Settings } from './Settings.js';
import { Input } from './Input.js';
import { Audio } from './Audio.js';
import { World } from '../world/World.js';
import { PostFX } from '../render/PostFX.js';
import { castRay } from '../shared/raycast.js';

// Keys the browser should hand to the game in fullscreen (so Ctrl+W, Ctrl+D,
// Ctrl+S... don't trigger browser shortcuts). Add new bindings here.
const LOCKED_KEYS = [
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyC', 'KeyR', 'KeyQ', 'KeyE', 'KeyF', 'KeyG', 'KeyB', 'KeyT', 'KeyN',
  'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5',
  'Space', 'Tab', 'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft',
];

// The Game owns the renderer, scenes, main loop and the lists of things that
// update each frame:
//   entities  - things in the world with a position (player, bots, ...)
//   systems   - global logic with update(dt) (rounds, effects, HUD, ...)
// Everything else talks through game.events.

export class Game {
  constructor(container) {
    this.container = container;

    this.renderer = new THREE.WebGLRenderer({ antialias: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, CONFIG.render.maxPixelRatio));
    this.renderer.shadowMap.enabled = CONFIG.render.shadows;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.autoClear = false;
    container.appendChild(this.renderer.domElement);
    this.postfx = new PostFX(this.renderer);

    // Main world. Tight near/far keeps depth precise for edge detection.
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(CONFIG.render.fov, 1, 0.1, 150);
    this.camera.rotation.order = 'YXZ';
    this.scene.add(this.camera);

    // Separate scene for the first-person gun so it never clips into walls.
    this.viewScene = new THREE.Scene();
    this.viewCamera = new THREE.PerspectiveCamera(CONFIG.render.viewmodelFov, 1, 0.01, 10);
    this.viewScene.add(new THREE.HemisphereLight(0xffffff, 0x554433, 1.6));
    const vmSun = new THREE.DirectionalLight(0xffffff, 1.5);
    vmSun.position.set(1, 2, 1);
    this.viewScene.add(vmSun);

    this.events = new Events();
    this.settings = new Settings(this.events);
    this.input = new Input(this.renderer.domElement);
    this.audio = new Audio();
    this.audio.setVolume(this.settings.get('volume'));
    this.events.on('settingChanged', ({ name, value }) => name === 'volume' && this.audio.setVolume(value));

    this.entities = [];
    this.systems = [];
    this.world = null;
    this.player = null;
    this.session = null; // practice (RoundManager) or online (OnlineSession)
    this.time = 0;
    this.paused = true;
    this.tickAccum = 0;
    this.tickAlpha = 1; // 0..1 progress through the current tick (for drawing)
    this.tickStart = true; // true during the first logic step of a tick

    this.input.onLockChange = (locked) => {
      this.paused = !locked;
      this.events.emit(locked ? 'resume' : 'pause');
    };

    // Safety net: ask before closing the tab mid-game (e.g. an accidental Ctrl+W).
    let devReload = false;
    import.meta.hot?.on('vite:beforeFullReload', () => (devReload = true));
    window.addEventListener('beforeunload', (e) => {
      if (this.time > 0 && !devReload) {
        e.preventDefault();
        e.returnValue = '';
      }
    });

    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  // Call from a user gesture (click): grabs the mouse and enables audio.
  requestPlay() {
    this.audio.unlock();
    if (CONFIG.input.fullscreen) this.enterFullscreen();
    this.input.requestLock();
    // Some embedded browsers never grant pointer lock. If it has never worked
    // this session, fall back to playing with a visible cursor.
    clearTimeout(this.lockTimer);
    this.lockTimer = setTimeout(() => {
      if (!this.input.locked && !this.input.everLocked) {
        this.input.setFreeMode(true);
        this.events.emit('lockFallback');
      }
    }, 500);
  }

  // Fullscreen + Keyboard Lock lets the game receive shortcuts like Ctrl+W
  // instead of the browser closing the tab. Chromium only; elsewhere it
  // just goes fullscreen (or does nothing).
  enterFullscreen() {
    const el = document.documentElement;
    if (document.fullscreenElement || !el.requestFullscreen) return;
    // Lock only game keys. Escape is left out so a single press still
    // pauses and exits fullscreen (locking it forces a 2-second hold).
    el.requestFullscreen()
      .then(() => navigator.keyboard?.lock?.(LOCKED_KEYS))
      .catch(() => {});
  }

  loadMap(def) {
    this.world?.dispose();
    this.world = new World(this, def);
    this.audio.world = this.world; // occlusion + room probing
    return this.world;
  }

  addEntity(entity) {
    this.entities.push(entity);
    return entity;
  }

  removeEntity(entity) {
    const i = this.entities.indexOf(entity);
    if (i >= 0) this.entities.splice(i, 1);
    entity.dispose();
  }

  addSystem(system) {
    this.systems.push(system);
    return system;
  }

  removeSystem(system) {
    const i = this.systems.indexOf(system);
    if (i >= 0) this.systems.splice(i, 1);
  }

  // Hitscan against the map boxes and every living entity's hitboxes (pure
  // math, shared with the server: see shared/raycast.js).
  // Returns { point, normal, distance, entity, part } or null.
  raycast(origin, direction, far = 1000, ignore = null) {
    const bodies = [];
    for (const e of this.entities) {
      if (e !== ignore && e.alive && e.hitShapes) bodies.push({ entity: e, shapes: e.hitShapes() });
    }
    return castRay(origin, direction, far, this.world.colliders, bodies);
  }

  start() {
    let last = performance.now();
    this.renderer.setAnimationLoop(() => {
      const now = performance.now();
      const dt = Math.min((now - last) / 1000, CONFIG.physics.maxFrameTime);
      last = now;
      // An uncaught error would stop the animation loop for good (looks like
      // a freeze), so catch it, pause, and report it on screen instead.
      try {
        this.update(dt);
        this.render();
      } catch (err) {
        console.error(err);
        if (!this.paused) document.exitPointerLock?.();
        this.input.setFreeMode(false);
        this.paused = true;
        this.events.emit('error', err);
      }
    });
  }

  // Game ticks. Logic (movement, shooting, reloads, bots) always runs on a
  // fixed tick, like a multiplayer server:
  //   - the base tick is CONFIG.physics.tickRate (64 Hz), so timings such as
  //     fire rates are exact whole numbers of ticks on any monitor
  //   - settings 'tickLength' (> 0, seconds) slows it down on purpose for a
  //     felt rhythm (OSRS uses 0.6 s); each slow tick runs as a burst of
  //     base-rate physics steps, with actions only on the first
  // Entities are drawn replaying their path through the last tick, and mouse
  // look, ADS, effects, audio and the HUD run every frame.
  update(dt) {
    // Before any logic: e.g. the online session advances its clock so this
    // frame's commands carry the right view tick.
    for (const s of this.systems) s.preUpdate?.(dt);
    const tick = this.tickLength;
    this.input.holdPresses = true; // presses wait for the tick that uses them
    // Online the world keeps going while you're in the pause menu (you just
    // stand still); practice pauses.
    if (!this.paused || this.session?.online) {
      this.time += dt;
      this.tickAccum += dt;
      while (this.tickAccum >= tick) {
        this.tickAccum -= tick;
        this.runTick(tick);
      }
      this.tickAlpha = this.tickAccum / tick;
      for (const e of [...this.entities]) e.frame(dt, this.tickAlpha);
      this.updateAudio(dt);
    }
    // Systems with `alwaysUpdate` (like the HUD) keep running while paused.
    for (const s of this.systems) {
      if (!this.paused || s.alwaysUpdate) s.update?.(dt);
    }
    this.input.endFrame();
  }

  // Seconds per logic tick right now.
  get tickLength() {
    if (this.session?.online) return 1 / CONFIG.physics.tickRate; // the server's rate
    const slow = this.settings.get('tickLength');
    return slow > 0 ? slow : 1 / CONFIG.physics.tickRate;
  }

  // Listener follows the camera; the room is re-measured a few times a second.
  updateAudio(dt) {
    this.audio.updateListener(this.camera);
    this.roomProbeTimer = (this.roomProbeTimer ?? 0) - dt;
    if (this.roomProbeTimer <= 0) {
      this.roomProbeTimer = 0.25;
      this.audio.probeRoom(this.world, this.camera.position);
    }
  }

  // One game tick: the whole tick's logic at once, in small fixed steps so
  // physics behaves the same as real time. Actions (firing, switching...)
  // happen only on the first step, so at most one per tick.
  runTick(tick) {
    const steps = Math.max(1, Math.round(tick * CONFIG.physics.tickRate));
    const step = tick / steps;
    for (let i = 0; i < steps; i++) this.runStep(step, i === 0);
    this.input.clearPresses();
    this.events.emit('tickEnd');
  }

  runStep(dt, tickStart) {
    this.tickStart = tickStart;
    if (tickStart) for (const e of this.entities) e.beginTick();
    for (const e of [...this.entities]) e.update(dt);
    for (const e of this.entities) e.recordStep();
  }

  render() {
    this.postfx.render(this.scene, this.camera, this.viewScene, this.viewCamera);
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.postfx.setSize(w, h);
    for (const cam of [this.camera, this.viewCamera]) {
      cam.aspect = w / h;
      cam.updateProjectionMatrix();
    }
  }
}
