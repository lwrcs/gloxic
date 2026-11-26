// Global tuning knobs. Gameplay numbers live here so they're easy to tweak
// without digging through code. Weapon stats live in weapons/definitions.js.

export const CONFIG = {
  render: {
    fov: 75,
    viewmodelFov: 60,
    maxPixelRatio: 2,
    shadows: true,
    // Stylized post-process (render/PostFX.js).
    pixelScale: 1, // internal resolution vs. window size (0.5 = chunkier pixels)
    ditherLevels: 2, // grey steps the lighting is dithered between
    ditherGain: 1.0, // overall lighting brightness before dithering (higher = more dots)
    depthEdge: 0.02, // silhouette sensitivity (lower = more outlines)
    normalEdge: 0.8, // crease sensitivity (higher = more outlines)
  },

  // Outline brightness per kind of object (0 = black, 1 = white).
  outlines: {
    world: 0.5,
    enemy: 1.0,
    weapon: 0.8,
  },

  physics: {
    tickRate: 64, // logic ticks per second (fire rates are whole numbers of ticks)
    gravity: 22,
    maxFrameTime: 0.05, // clamp long frames so physics doesn't explode
  },

  input: {
    mouseSensitivity: 0.00055, // radians per pixel at slider value 1.0
    // true = go fullscreen with Keyboard Lock on play, which stops Ctrl+W
    // closing the tab. false = stay windowed.
    fullscreen: false,
  },

  teams: {
    player: 'blue',
    bots: 'red',
  },

  player: {
    radius: 0.35,
    height: 1.8,
    crouchHeight: 1.2,
    eyeOffset: 0.15, // eye distance below top of head
    runSpeed: 7.44,
    walkSpeed: 4.08, // hold Shift
    crouchSpeed: 3.12,
    jumpSpeed: 7.2,
    groundAccel: 70,
    airAccel: 10,
    maxHealth: 150,
    loadout: ['rifle', 'pistol', 'shotgun', 'knife'], // slots 1-4; Q = knife
    switchTime: 0.05, // seconds before a swapped-to weapon can fire
    adsTime: 0.12, // seconds to fully aim down sights
    recoilViewSpeed: 30, // how fast the view catches up to the spray pattern (1/s)
  },

  // Multipliers on each weapon's spray pattern size.
  spreadScale: {
    enabled: false, // testing phase: recoil ignores stance/movement/ADS (always 1x)
    still: 0.5,
    moving: 0.7,
    ads: 0.3,
    air: 2.0, // extra multiplier while airborne
    crouch: 0.8, // extra multiplier while crouched
  },

  viewmodel: {
    bob: 0.05, // weapon bob amount (1 = original, 0.05 = very subtle)
  },

  bots: {
    count: 4, // default; the Enemies slider in Settings overrides it
    radius: 0.35,
    height: 1.8,
    speed: 4.2, // running (combat, investigating)
    walkSpeed: 2.2, // patrolling
    accel: 30,
    turnSpeed: 4.5, // radians / second: spotting you from the side takes a moment
    maxHealth: 150,
    weapon: 'rifle',
    aimError: 0.05, // random aim error in radians (bots only; the player has no random spread)
    repathInterval: 0.6,

    // Sight: walls block it (raycast to your chest / head).
    sightRange: 60,
    fov: 50, // degrees either side of facing: clear view
    peripheral: 100, // degrees either side: corner of the eye (slow to notice)
    peripheralFactor: 0.3, // how much slower peripheral noticing is
    noticeTime: 0.35, // seconds to spot you head-on, close, moving, standing up
    crouchFactor: 0.55, // crouching is harder to notice
    stillFactor: 0.6, // so is standing still
    // After spotting you: turn to face you, then hold aim this long to fire.
    aimTime: 0.35,
    aimTolerance: 0.08, // radians off target that still counts as aimed

    // Hearing: each noise has a radius (gunshot 45-60 m, running footstep
    // 14 m, landing 11 m, bullet impact 7 m, knife 2.5-5 m; walking and
    // crouching make none). Through walls the radius is halved.
    hearing: 1,
    searchTime: 4, // seconds spent looking around where they lost you
  },


  round: {
    duration: 115,
    restartDelay: 4,
  },
};
