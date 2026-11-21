// Sound manifest: named sets of sample variations, loaded at startup by
// main.js. Files live in public/sounds/<group>/ and are served from the site
// root. Add a set here and reference it by name (e.g. a weapon's sound.set).
//
// Naming: <group>_<what>_<NN>.wav, e.g. public/sounds/rifle/rifle_shot_01.wav

const BASE = `${import.meta.env.BASE_URL}sounds/`;

// ['rifle/rifle_shot_01.wav', ... 'rifle/rifle_shot_NN.wav']
function numbered(folder, prefix, count) {
  return Array.from({ length: count }, (_, i) => `${BASE}${folder}/${prefix}_${String(i + 1).padStart(2, '0')}.wav`);
}

export const SOUND_SETS = {
  rifle_shot: numbered('rifle', 'rifle_shot', 12),
  // Shotgun files are 48 kHz / 16-bit; the shot is normalized to -12 LUFS
  // (about as loud as the rifle samples), the pump to -17.5 LUFS.
  shotgun_shot: numbered('shotgun', 'shotgun_shot', 1),
  shotgun_pump: numbered('shotgun', 'shotgun_pump', 1), // cock / pump after each shot
};
