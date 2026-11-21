// Keyboard + mouse state with pointer lock. Query it from update():
//   isDown(code)        held right now
//   wasPressed(code)    went down this frame (or since the last game tick,
//                       when ticks are on: presses are held until they're used)
//   consumeMouse()      mouse movement since last call
// Key codes are KeyboardEvent.code values ('KeyW', 'Space', 'ShiftLeft'...).

const MAX_MOUSE_DELTA = 250; // some browsers spike movementX on lock

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

    window.addEventListener('keydown', (e) => {
      if (!this.keys.has(e.code)) this.pressed.add(e.code);
      this.keys.add(e.code);
      if (this.active && (e.code === 'Space' || e.code === 'Tab' || e.ctrlKey)) e.preventDefault();
      if (e.code === 'Escape') {
        // With Keyboard Lock the browser no longer releases the mouse on Esc,
        // so pause ourselves.
        if (this.locked) document.exitPointerLock();
        if (this.freeMode) this.setFreeMode(false);
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));

    window.addEventListener('mousedown', (e) => {
      if (!this.active) return;
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
  }

  get active() {
    return this.locked || this.freeMode;
  }

  setFreeMode(on) {
    if (this.freeMode === on) return;
    this.freeMode = on;
    if (!on) this.clear();
    this.onLockChange?.(this.active);
  }

  requestLock() {
    try {
      const p = this.element.requestPointerLock();
      p?.catch?.(() => {}); // Chrome rejects if re-locking too fast after Esc
    } catch {
      /* ignore */
    }
  }

  isDown(code) {
    return this.keys.has(code);
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

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
