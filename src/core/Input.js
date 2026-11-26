// Keyboard + mouse state with pointer lock. Query it from update():
//   isDown(code)        held right now
//   wasPressed(code)    went down this frame (or since the last game tick,
//                       when ticks are on: presses are held until they're used)
//   consumeMouse()      mouse movement since last call
// Key codes are KeyboardEvent.code values ('KeyW', 'Space', 'ShiftLeft'...).

const MAX_MOUSE_DELTA = 250; // some browsers spike movementX on lock
const PAD_DEAD_ZONE = 0.25; // stick travel ignored (drift, light touches)
const PAD_DIR = 0.38; // sin(22.5 deg): 8-way thresholds, like WASD

export class Input {
  constructor(element) {
    this.element = element;
    this.keys = new Set();
    this.pressed = new Set();
    this.mouseButtons = new Set();
    this.mousePressed = new Set();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
    this.locked = false;
    this.everLocked = false;
    this.freeMode = false; // playing without pointer lock (cursor visible)
    this.onLockChange = null; // called with `active`
    this.holdPresses = false; // tick mode: keep presses until clearPresses()
    this.padKeys = new Set(); // movement keys held by a gamepad stick (pollGamepads)
    this.lockWantedAt = -Infinity; // when the game last asked for pointer lock
    this.inMatch = () => false; // set by Game: a practice or online session is running

    window.addEventListener('keydown', (e) => {
      const typing = isEditable(e.target);
      // A text box (friend code, name) can keep focus after the menu hides.
      // Letters typed into it can be swallowed by the box or a Windows IME,
      // so once we're playing, take focus back to the page.
      if (typing && this.capturing) e.target.blur();
      else if (typing) return; // typing in the menu isn't game input
      const code = keyCode(e);
      if (!this.keys.has(code)) this.pressed.add(code);
      this.keys.add(code);
      this.blockBrowserKey(e);
      if (code === 'Escape') {
        // With Keyboard Lock the browser no longer releases the mouse on Esc,
        // so pause ourselves.
        if (this.locked) document.exitPointerLock();
        if (this.freeMode) this.setFreeMode(false);
      }
    });
    window.addEventListener('keyup', (e) => {
      const code = keyCode(e);
      this.keys.delete(code);
      // A fallback code and the real one could differ between down and up.
      if (e.code) this.keys.delete(e.code);
      // Releasing Alt on Windows would focus the browser's menu.
      if (this.capturing && (code === 'AltLeft' || code === 'AltRight')) e.preventDefault();
    });

    window.addEventListener('mousedown', (e) => {
      if (!this.active) return;
      // Playing with a visible cursor because the lock didn't take (see
      // below): any click tries again, so aim isn't stuck between the
      // screen edges.
      if (this.freeMode && !this.locked && e.pointerType !== 'touch') this.requestLock();
      this.mouseButtons.add(e.button);
      this.mousePressed.add(e.button);
    });
    window.addEventListener('mouseup', (e) => this.mouseButtons.delete(e.button));
    window.addEventListener('mousemove', (e) => {
      if (!this.active) return;
      this.mouseDX += clamp(e.movementX, -MAX_MOUSE_DELTA, MAX_MOUSE_DELTA);
      this.mouseDY += clamp(e.movementY, -MAX_MOUSE_DELTA, MAX_MOUSE_DELTA);
    });
    window.addEventListener(
      'wheel',
      (e) => {
        if (this.active) this.wheel += Math.sign(e.deltaY);
      },
      { passive: true },
    );
    window.addEventListener('contextmenu', (e) => this.active && e.preventDefault());
    window.addEventListener('blur', () => this.clear());
    document.addEventListener('visibilitychange', () => document.hidden && this.clear());

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.element;
      if (this.locked) {
        this.everLocked = true;
        this.freeMode = false;
      } else {
        this.clear();
      }
      this.onLockChange?.(this.active);
    });
    document.addEventListener('pointerlockerror', () => console.warn('Pointer lock was refused'));
    // Going fullscreen on the same click can make Chrome refuse or drop the
    // pointer lock (fullscreen uses up the click's permission). Then aim
    // falls back to the visible cursor and stops at the screen edges. Once
    // fullscreen is in, ask for the lock again.
    document.addEventListener('fullscreenchange', () => {
      if (document.fullscreenElement && !this.locked && performance.now() - this.lockWantedAt < 3000) this.requestLock();
    });
  }

  get active() {
    return this.locked || this.freeMode;
  }

  // Keys are kept from the browser while playing, and also while the pause
  // menu is up during a match (crouch is Ctrl, so a stray Ctrl+S, Ctrl+D,
  // Ctrl+F... mustn't open browser dialogs). Ctrl+W, Ctrl+T and Ctrl+N never
  // reach a page in a normal window: fullscreen with Keyboard Lock catches
  // them (Game.enterFullscreen), and the "Leave site?" prompt is the backstop.
  get capturing() {
    return this.active || this.inMatch();
  }

  blockBrowserKey(e) {
    if (!this.capturing) return;
    const c = e.code;
    // Modifier combos and Alt (which focuses the browser menu on Windows):
    // during the whole match. Space / Tab / arrows / find keys: only while
    // actually playing, so the pause menu's sliders and boxes still work.
    if (e.ctrlKey || e.altKey || e.metaKey || c === 'AltLeft' || c === 'AltRight') e.preventDefault();
    else if (this.active && (c === 'Space' || c === 'Tab' || c.startsWith('Arrow') || c === 'F1' || c === 'F3')) e.preventDefault();
  }

  // Start playing: drop focus from any menu text box so keys reach the game.
  releaseFocus() {
    const el = document.activeElement;
    if (el && el !== document.body && typeof el.blur === 'function') el.blur();
  }

  setFreeMode(on) {
    if (this.freeMode === on) return;
    this.freeMode = on;
    if (!on) this.clear();
    this.onLockChange?.(this.active);
  }

  requestLock() {
    this.lockWantedAt = performance.now();
    try {
      const p = this.element.requestPointerLock();
      p?.catch?.(() => {}); // Chrome rejects if re-locking too fast after Esc
    } catch {
      /* ignore */
    }
  }

  isDown(code) {
    return this.keys.has(code) || this.padKeys.has(code);
  }

  // Gamepad left stick -> WASD, once per frame. Needed for analog keyboards:
  // Wooting's Wootility can turn WASD into a virtual Xbox controller's left
  // stick, and in that mode the keys send no keyboard events at all, so
  // only the gamepad sees them (other keys still type normally). Real
  // controllers work the same way. Kept apart from `keys` so an idle pad
  // never cancels keyboard movement.
  pollGamepads() {
    this.padKeys.clear();
    if (!this.active || !navigator.getGamepads) return;
    let x = 0;
    let y = 0;
    try {
      for (const pad of navigator.getGamepads()) {
        if (!pad || !pad.connected || pad.axes.length < 2) continue;
        const [ax, ay] = pad.axes;
        if (Math.hypot(ax, ay) > Math.hypot(x, y)) [x, y] = [ax, ay];
      }
    } catch {
      return; // blocked by permissions policy
    }
    const mag = Math.hypot(x, y);
    if (mag < PAD_DEAD_ZONE) return;
    const nx = x / mag;
    const ny = y / mag;
    if (ny < -PAD_DIR) this.padKeys.add('KeyW');
    if (ny > PAD_DIR) this.padKeys.add('KeyS');
    if (nx < -PAD_DIR) this.padKeys.add('KeyA');
    if (nx > PAD_DIR) this.padKeys.add('KeyD');
  }

  wasPressed(code) {
    return this.pressed.has(code);
  }

  // Marks a press as handled so it doesn't trigger again before it's cleared.
  consumePress(code) {
    this.pressed.delete(code);
  }

  isMouseDown(button = 0) {
    return this.mouseButtons.has(button);
  }

  wasMousePressed(button = 0) {
    return this.mousePressed.has(button);
  }

  consumeMouse() {
    const d = { x: this.mouseDX, y: this.mouseDY };
    this.mouseDX = 0;
    this.mouseDY = 0;
    return d;
  }

  clear() {
    this.keys.clear();
    this.mouseButtons.clear();
  }

  // One-shot inputs (presses, wheel). Cleared every frame, or after each
  // game tick when ticks are on so a quick tap between ticks isn't lost.
  clearPresses() {
    this.pressed.clear();
    this.mousePressed.clear();
    this.wheel = 0;
  }

  endFrame() {
    if (!this.holdPresses) this.clearPresses();
    this.mouseDX = 0;
    this.mouseDY = 0;
  }
}

// KeyboardEvent.code, with fallbacks. Some Windows setups send letter keys
// with an empty or 'Unidentified' code: keys injected by keyboard software
// (remappers, macro / RGB utilities, analog keyboards, on-screen keyboards
// all send virtual keys with no scancode), or an IME in the way. Fall back
// to the virtual key code, then to the character.
const VK = { 37: 'ArrowLeft', 38: 'ArrowUp', 39: 'ArrowRight', 40: 'ArrowDown', 8: 'Backspace', 9: 'Tab', 13: 'Enter', 16: 'ShiftLeft', 17: 'ControlLeft', 18: 'AltLeft', 27: 'Escape', 32: 'Space' };
for (let i = 0; i < 26; i++) VK[65 + i] = `Key${String.fromCharCode(65 + i)}`;
for (let i = 0; i < 10; i++) VK[48 + i] = `Digit${i}`;

export function keyCode(e) {
  if (e.code && e.code !== 'Unidentified') return e.code;
  if (VK[e.keyCode]) return VK[e.keyCode];
  const ch = typeof e.key === 'string' && e.key.length === 1 ? e.key.toUpperCase() : '';
  if (ch >= 'A' && ch <= 'Z') return `Key${ch}`;
  if (ch >= '0' && ch <= '9') return `Digit${ch}`;
  return e.code || e.key || '';
}

function isEditable(el) {
  if (!el || el === document.body) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  return el.tagName === 'INPUT' && !['checkbox', 'radio', 'range', 'button', 'submit', 'reset', 'color', 'file'].includes(el.type);
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
