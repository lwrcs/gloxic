// On-screen controls for phones and tablets. They don't add a new input
// path: they press the same virtual keys / mouse buttons the keyboard and
// mouse do (game.input), so movement, shooting and the netcode all work
// unchanged.
//
//   left side    floating joystick: push it a little = walk (silent),
//                push it far = run. Eight directions, like WASD.
//   right side   drag to look
//   buttons      FIRE (hold; drag on it to aim while shooting), AIM (toggle),
//                JUMP, CROUCH (toggle), RELOAD, SWAP (next weapon), KNIFE,
//                pause, and SCORES (online, hold)

const STICK_RADIUS = 60; // px the knob can travel
const DEAD_ZONE = 0.2;
const RUN_AT = 0.65; // push past this fraction to run (below = walk, silent)
const DIR = 0.38; // sin(22.5 deg): 8-way thresholds
const LOOK_GAIN = 9; // touch pixels -> mouse pixels (then the sensitivity setting applies)

export function isTouchDevice() {
  return matchMedia('(pointer: coarse)').matches || (navigator.maxTouchPoints > 0 && !matchMedia('(pointer: fine)').matches);
}

export class TouchControls {
  constructor(game) {
    this.game = game;
    this.input = game.input;
    this.alwaysUpdate = true;
    this.touches = new Map(); // identifier -> { kind, x, y, ... }
    this.stickKeys = new Set();
    this.crouch = false;
    this.ads = false;

    this.el = document.createElement('div');
    this.el.className = 'touch-controls';
    this.el.innerHTML = `
      <div class="stick"><div class="knob"></div></div>
      <button class="tbtn fire" data-act="fire">FIRE</button>
      <button class="tbtn ads" data-act="ads">AIM</button>
      <button class="tbtn jump" data-act="jump">JUMP</button>
      <button class="tbtn crouch" data-act="crouch">CROUCH</button>
      <button class="tbtn reload" data-act="reload">R</button>
      <button class="tbtn swap" data-act="swap">SWAP</button>
      <button class="tbtn knife" data-act="knife">KNIFE</button>
      <button class="tbtn small pause" data-act="pause">II</button>
      <button class="tbtn small scores" data-act="scores">SCORES</button>
      <div class="rotate-hint">Turn your phone sideways</div>`;
    document.body.appendChild(this.el);
    this.stick = this.el.querySelector('.stick');
    this.knob = this.el.querySelector('.knob');
    this.buttons = Object.fromEntries([...this.el.querySelectorAll('[data-act]')].map((b) => [b.dataset.act, b]));

    const opts = { passive: false };
    this.el.addEventListener('touchstart', (e) => this.onStart(e), opts);
    this.el.addEventListener('touchmove', (e) => this.onMove(e), opts);
    this.el.addEventListener('touchend', (e) => this.onEnd(e), opts);
    this.el.addEventListener('touchcancel', (e) => this.onEnd(e), opts);
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  get playing() {
    return this.input.active && !document.body.classList.contains('in-menu') && !!this.game.session;
  }

  onStart(e) {
    e.preventDefault(); // no synthetic mouse events, scrolling or zoom
    if (!this.playing) return;
    for (const t of e.changedTouches) {
      const btn = t.target.closest?.('[data-act]');
      if (btn) {
        const act = btn.dataset.act;
        this.touches.set(t.identifier, { kind: 'button', act, x: t.clientX, y: t.clientY });
        this.press(act, true);
        btn.classList.add('down');
      } else if (t.clientX < window.innerWidth * 0.42 && ![...this.touches.values()].some((s) => s.kind === 'stick')) {
        this.touches.set(t.identifier, { kind: 'stick', ox: t.clientX, oy: t.clientY });
        this.stick.style.display = 'block';
        this.stick.style.transform = `translate(${t.clientX}px, ${t.clientY}px)`;
        this.knob.style.transform = 'translate(-50%, -50%)';
      } else {
        this.touches.set(t.identifier, { kind: 'look', x: t.clientX, y: t.clientY });
      }
    }
  }

  onMove(e) {
    e.preventDefault();
    for (const t of e.changedTouches) {
      const s = this.touches.get(t.identifier);
      if (!s) continue;
      if (s.kind === 'stick') {
        let dx = t.clientX - s.ox;
        let dy = t.clientY - s.oy;
        const len = Math.hypot(dx, dy);
        if (len > STICK_RADIUS) {
          dx = (dx / len) * STICK_RADIUS;
          dy = (dy / len) * STICK_RADIUS;
        }
        this.knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
        this.setStick(dx / STICK_RADIUS, dy / STICK_RADIUS);
      } else if (s.kind === 'look' || (s.kind === 'button' && s.act === 'fire')) {
        // Look; dragging on FIRE also aims while shooting.
        const gain = LOOK_GAIN * (this.game.settings.get('touchSensitivity') ?? 1);
        this.input.mouseDX += (t.clientX - s.x) * gain;
        this.input.mouseDY += (t.clientY - s.y) * gain;
        s.x = t.clientX;
        s.y = t.clientY;
      }
    }
  }

  onEnd(e) {
    e.preventDefault();
    for (const t of e.changedTouches) {
      const s = this.touches.get(t.identifier);
      if (!s) continue;
      this.touches.delete(t.identifier);
      if (s.kind === 'stick') {
        this.setStick(0, 0);
        this.stick.style.display = 'none';
      } else if (s.kind === 'button') {
        this.press(s.act, false);
        this.buttons[s.act]?.classList.remove('down');
      }
    }
  }

  // Joystick -> WASD (+ Shift to walk when only pushed a little).
  setStick(x, y) {
    const keys = new Set();
    const mag = Math.hypot(x, y);
    if (mag > DEAD_ZONE) {
      const nx = x / mag;
      const ny = y / mag;
      if (ny < -DIR) keys.add('KeyW');
      if (ny > DIR) keys.add('KeyS');
      if (nx < -DIR) keys.add('KeyA');
      if (nx > DIR) keys.add('KeyD');
      if (mag < RUN_AT) keys.add('ShiftLeft');
    }
    for (const k of this.stickKeys) if (!keys.has(k)) this.input.keys.delete(k);
    for (const k of keys) this.input.keys.add(k);
    this.stickKeys = keys;
  }

  press(act, down) {
    const input = this.input;
    switch (act) {
      case 'fire':
        if (down) {
          input.mouseButtons.add(0);
          input.mousePressed.add(0);
        } else input.mouseButtons.delete(0);
        break;
      case 'ads':
        if (down) {
          this.ads = !this.ads;
          if (this.ads) input.mouseButtons.add(2);
          else input.mouseButtons.delete(2);
        }
        break;
      case 'jump':
        if (down) {
          input.keys.add('Space');
          input.pressed.add('Space');
        } else input.keys.delete('Space');
        break;
      case 'crouch':
        if (down) {
          this.crouch = !this.crouch;
          if (this.crouch) input.keys.add('ControlLeft');
          else input.keys.delete('ControlLeft');
        }
        break;
      case 'reload':
        if (down) input.pressed.add('KeyR');
        break;
      case 'swap':
        if (down) input.wheel += 1;
        break;
      case 'knife':
        if (down) input.pressed.add('KeyQ');
        break;
      case 'scores':
        if (down) input.keys.add('Tab');
        else input.keys.delete('Tab');
        break;
      case 'pause':
        if (down) this.pause();
        break;
    }
  }

  pause() {
    this.reset();
    this.input.setFreeMode(false); // -> 'pause' event, overlay shows
  }

  // Let go of everything (pausing, leaving, losing focus).
  reset() {
    this.touches.clear();
    this.setStick(0, 0);
    this.stick.style.display = 'none';
    this.crouch = false;
    this.ads = false;
    this.input.keys.clear();
    this.input.mouseButtons.clear();
    for (const b of Object.values(this.buttons)) b.classList.remove('down');
  }

  update() {
    const playing = this.playing;
    if (!playing && this.touches.size) this.reset();
    document.body.classList.toggle('touch-playing', playing);
    this.buttons.crouch.classList.toggle('on', this.crouch);
    this.buttons.ads.classList.toggle('on', this.ads);
    this.buttons.scores.style.display = this.game.session?.online ? '' : 'none';
    const melee = !!this.game.player?.weapon?.def.melee;
    this.buttons.ads.style.visibility = melee ? 'hidden' : '';
    this.buttons.reload.style.visibility = melee ? 'hidden' : '';
    this.buttons.knife.textContent = melee ? 'GUN' : 'KNIFE';
  }
}
