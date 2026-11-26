// Sandhollow: a sun-baked desert town built for Bomb mode (original layout).
//
//   Attackers start at the Caravan Gate (south), defenders at the Well
//   Plaza (north). Two bomb sites:
//     A  the Cistern Yard (north-west): reached by the long, open Salt Road
//        on the west edge (the long sightline) or the narrow Rope Walk from
//        the middle plaza.
//     B  the Kiln Yard (north-east): reached by the twisting Potters' Alley
//        on the east edge (under an arch) or the Dye Lane from mid.
//   The middle is a long market street with a statue plaza; the covered
//   Arcade links the Salt Road and mid for rotations.
//
// Tiles: '#' buildings, 'H' tall towers, 'C' crate stacks (too tall to
// jump), 'c' crates and 'w' low walls (jump up), 'o' cistern, 'K' kiln,
// 'T' statue, '=' overhead arches / awnings (walk underneath).
// 'a' attacker spawns, 'd' defender spawns. Sites are cell rectangles.

export default {
  name: 'Sandhollow',
  cellSize: 2,

  // Hazy, bright desert: a mid-grey sky that dithers into heat haze.
  environment: {
    sky: '#6b6457',
    fogNear: 45,
    fogFar: 140,
    sunColor: '#fff4dc',
    sunIntensity: 2.6,
    ambientIntensity: 0.75,
  },

  floor: { shade: 0.5 },

  tiles: {
    '#': { solid: true, height: 6, shade: 0.42 },
    'H': { solid: true, height: 10, shade: 0.36 },
    'C': { solid: true, height: 2, shade: 0.6 },
    'c': { solid: true, height: 1.1, shade: 0.6 },
    'w': { solid: true, height: 1.0, shade: 0.5 },
    'o': { solid: true, height: 1.4, shade: 0.3 },
    'K': { solid: true, height: 3, shade: 0.3 },
    'T': { solid: true, height: 3.4, shade: 0.55 },
    '=': { solid: true, base: 3.2, height: 1.4, shade: 0.4 },
  },

  spawns: {
    'a': 'attack',
    'd': 'defend',
  },
  // Modes with plain teams (deathmatch) use these spawn sides.
  teamSpawns: { blue: 'attack', red: 'defend' },

  // Bomb sites in grid cells (inclusive): plant anywhere inside.
  sites: {
    A: { x: [3, 11], z: [3, 10] },
    B: { x: [36, 44], z: [4, 11] },
  },

  layout: [
    '################################################',
    '################################################',
    '##...........######..........###################',
    '##........CC.........d.d.d...######...........##',
    '##....................d.d.d...==...........CC.##',
    '##....CC......................==..............##',
    '##....CC.....######.c......c..==......CC......##',
    '##......c....######..........######...CCc.....##',
    '##...........########......########...........##',
    '##.www...oo....#HHH##......########......KK...##',
    '##.......oo....#HHH##......#####HHH.www..KK...##',
    '##.............#HHH##.wwww.#####HHH...........##',
    '##....#######==######......#####HHH...........##',
    '##....#######..######......#########..###....###',
    '##.www#######..###............######..###....###',
    '##....#######...............c.######..###====###',
    '##....#######..........TT.....######..###....###',
    '##....############.....TT.....######..###....###',
    '##....############.c..........######..###....###',
    '##....############............######..###....###',
    '##..c.####HHH###HHH####....#########..#####..###',
    '##....####HHH###HHH####....#########..#####..###',
    '##....####HHH###HHH####....###........#####..###',
    '##....###############......###........###....###',
    '##....###############C.....##############...c###',
    '##....###############......##############....###',
    '##......===========........##############....###',
    '##......===========........##############..#####',
    '##C...###############......######HHH#####..#####',
    '##....###############.....C######HHH#####..#####',
    '##....###############......######HHH#####....###',
    '##....###HHH#########......###########HHHc...###',
    '##....###HHH#########......###########HHH....###',
    '##....###HHH#########......###########HHH....###',
    '##....###########............................###',
    '##................c..........C...............###',
    '##...................a.a.a.a.................###',
    '##..................a.a.a.a....#################',
    '#################..............#################',
    '################################################',
  ],
};
