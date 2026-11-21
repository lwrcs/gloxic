// Weapon stats. Add a new gun by adding an entry here and putting its id in
// CONFIG.player.loadout (slot = position in the list). Angles are radians.
//
// pattern: fixed spray, no randomness. Each shot climbs `rise` (up to
//   `riseCap` shots) and swings sideways in a zig-zag of size `swing` that
//   repeats every `period` shots (starts centered, left first, then right).
//   The rifle's period of 8 gives 3.75 swings over its 30 rounds. `recovery` is
//   how many shots of pattern wind back per second after you stop firing.
//   CONFIG.spreadScale scales only the climb (standing / moving / ADS), locked
//   for the whole spray; the zig-zag always keeps its full width.
//
// Each gun keeps named patterns; ACTIVE_PATTERN picks which one is live.
//   vertical - straight climb with no cap (current testing phase)
//   zigzag   - the earlier left-first zig-zag with a capped climb (saved)
export const ACTIVE_PATTERN = 'vertical';

export const WEAPONS = {
  rifle: {
    id: 'rifle',
    name: 'AR-7',
    damage: { head: 105, body: 15, legs: 11 },
    fireTicks: 7, // ticks between shots at 64 Hz = 0.109 s (~549 rpm), exact at any frame rate
    automatic: true,
    magSize: 30,
    reserve: 90,
    reloadTime: 2.4,
    range: 200,
    patterns: {
      vertical: { rise: 0.018, riseCap: Infinity, swing: 0, period: 1, recovery: 18 },
      zigzag: { rise: 0.0045, riseCap: 20, swing: 0.02, period: 8, recovery: 18 },
    },
    adsZoom: 1.35, // FOV divisor while aiming
    noiseRadius: 60, // how far bots can hear it (metres, halved through walls)
    sound: { set: 'rifle_shot', volume: 1, pitch: 1 }, // set: name in audio/sounds.js (random variation per shot)
    model: { length: 0.6, stock: true },
  },

  pistol: {
    id: 'pistol',
    name: 'P-9',
    damage: { head: 87.5, body: 12.5, legs: 9.5 },
    fireRate: 380,
    automatic: false,
    magSize: 12,
    reserve: 48,
    reloadTime: 1.9,
    range: 150,
    patterns: {
      vertical: { rise: 0.032, riseCap: Infinity, swing: 0, period: 1, recovery: 10.8 },
      zigzag: { rise: 0.008, riseCap: 10, swing: 0.006, period: 4, recovery: 10.8 },
    },
    adsZoom: 1.15,
    noiseRadius: 45,
    sound: { pitch: 1.4 },
    model: { length: 0.22 },
  },

  shotgun: {
    id: 'shotgun',
    name: 'Breacher',
    damage: { head: 20, body: 10, legs: 7 }, // per pellet
    pellets: 8,
    pelletSpread: 0.035, // radius of the fixed pellet ring (narrow)
    fireRate: 120, // pump speed (rounds per minute)
    automatic: false,
    magSize: 3,
    reserve: 24,
    reloadTime: 2.6,
    range: 60,
    patterns: {
      vertical: { rise: 0.24, riseCap: Infinity, swing: 0, period: 1, recovery: 5.4 },
      zigzag: { rise: 0.015, riseCap: 5, swing: 0, period: 1, recovery: 5.4 },
    },
    adsZoom: 1.15,
    // after: pump/cock sound played `afterDelay` seconds after each shot.
    // (reload: a set timed to finish as the reload completes is also supported.)
    noiseRadius: 60,
    sound: { set: 'shotgun_shot', volume: 1.5, pitch: 1, after: 'shotgun_pump', afterDelay: 0.32, afterVolume: 0.7 },
    model: { length: 0.55, barrel: 0.045, mag: false, stock: true, pump: true },
  },

  knife: {
    id: 'knife',
    name: 'Knife',
    melee: true, // traces a short fan of rays; see Weapon.swing()
    damage: { head: 55, body: 40, legs: 30 },
    // Backstab (from behind, victim facing away): instant kill, TF2-style.
    fireRate: 120, // swings per minute
    automatic: true, // hold to keep swinging
    magSize: Infinity,
    reserve: Infinity,
    reloadTime: 0,
    range: 1.9,
    meleeSpread: 0.14, // half-angle of the hit fan (radians)
    patterns: {
      vertical: { rise: 0, riseCap: 0, swing: 0, period: 1, recovery: 10 },
      zigzag: { rise: 0, riseCap: 0, swing: 0, period: 1, recovery: 10 },
    },
    model: { knife: true },
  },
};

for (const w of Object.values(WEAPONS)) w.pattern = w.patterns[ACTIVE_PATTERN];
