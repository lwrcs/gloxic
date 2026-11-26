// Player preferences, saved in this browser's localStorage. Add a setting by
// adding a default here and a control in ui/HUD.js.
//
// Only settings the player has changed are saved, so changing a default here
// reaches everyone who hasn't picked their own value.

const KEY = 'gloxic.settings';
const OLD_KEY = 'boxstrike.settings'; // before the rename
const DEFAULTS = {
  sensitivity: 1.0, // multiplier on CONFIG.input.mouseSensitivity
  touchSensitivity: 1.0, // look speed for touch drags (phones / tablets)
  volume: 0.8, // master volume 0..1.5
  tickLength: 0, // seconds per game tick (0 = off, real time). OSRS uses 0.6
  recoilView: true, // the view turns with the spray pattern (crosshair stays on target)
  invincible: false, // player takes no damage
  infiniteAmmo: false, // mags never empty, no reloading
  noEnemies: false, // no bots spawn; the round timer is frozen
  botCount: 4, // enemies per round (1-10)
  // Fullscreen with Keyboard Lock on play: the only way a page can keep
  // Ctrl+W / Ctrl+T / Ctrl+N / Ctrl+Tab from the browser (Chrome / Edge).
  fullscreen: true,
};

export class Settings {
  constructor(events) {
    this.events = events;
    this.saved = {};
    try {
      this.saved = JSON.parse(localStorage.getItem(KEY) || localStorage.getItem(OLD_KEY) || '{}') ?? {};
    } catch {
      /* storage unavailable: use defaults */
    }
    // Earlier tick defaults (0.6, then 0.3) may have been saved; drop them so
    // the current default (real time) applies.
    if (this.saved.tickLength === 0.6 || this.saved.tickLength === 0.3) delete this.saved.tickLength;
    this.values = { ...DEFAULTS, ...this.saved };
  }

  get(name) {
    return this.values[name];
  }

  set(name, value) {
    this.values[name] = value;
    this.saved[name] = value;
    try {
      localStorage.setItem(KEY, JSON.stringify(this.saved));
    } catch {
      /* ignore */
    }
    this.events.emit('settingChanged', { name, value });
  }
}
