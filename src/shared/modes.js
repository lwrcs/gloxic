// Game modes for online matches. The server runs the rules (server/src/
// rules.js); the client uses these for the menu and the HUD.

export const MODES = {
  duel: {
    id: 'duel',
    name: '1v1',
    description: 'Rounds, one life each. First to 6 round wins.',
    minPlayers: 2,
    maxPlayers: 2,
    roundsToWin: 6,
    roundTime: 90, // seconds
    freezeTime: 2.5, // start of each round: you can look and switch weapons, not move or shoot
    roundEndTime: 3,
  },
  tdm: {
    id: 'tdm',
    name: 'Team Deathmatch',
    description: 'Respawns on. First team to 30 kills, or the most after 8 minutes.',
    minPlayers: 1, // 1 lets you try it alone
    maxPlayers: 10,
    scoreLimit: 30,
    timeLimit: 8 * 60,
    respawnTime: 3,
    spawnProtection: 1.5, // seconds of invulnerability (ends when you fire)
    freezeTime: 3,
  },
};

export const DEFAULT_MODE = 'duel';
export const TEAMS = ['blue', 'red'];
