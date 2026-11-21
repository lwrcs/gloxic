// Maps are ASCII grids. Each character is one cell (cellSize world units).
// `tiles` says what each character builds; `spawns` marks spawn cells for a
// team. Any other character (like '.') is open floor.
//
// To add a map: copy this file, edit the layout, and pass it to
// game.loadMap() in main.js.

export default {
  name: 'Boxyard',
  cellSize: 2,

  // Black sky; fog fades distant geometry into it.
  environment: {
    sky: '#000000',
    fogNear: 25,
    fogFar: 90,
    sunColor: '#ffffff',
    sunIntensity: 1.6,
    ambientIntensity: 0.5,
  },

  // shade: brightness under light (dithered); outline: edge brightness.
  floor: { shade: 0.22 },

  tiles: {
    '#': { solid: true, height: 4, shade: 0.25 },
    'C': { solid: true, height: 2, shade: 0.3 },
    'c': { solid: true, height: 1.1, shade: 0.3 },
  },

  spawns: {
    'P': 'blue',
    'B': 'red',
  },

  layout: [
    '################################',
    '#B..B..#.......#######......cc.#',
    '#..B...#.......#.....#..B...cc.#',
    '#..cc..#..C....#..C..#.........#',
    '#..cc..............c...........#',
    '#B.....#.......#.....#....C....#',
    '###.####.......##...##.........#',
    '#.......................######.#',
    '#..C....####........#..........#',
    '#.......#..#...cc...#...cc.....#',
    '#.......#..#...cc...#...cc.....#',
    '#..c....####........#..........#',
    '#.......................####...#',
    '#..######..##...C...##.........#',
    '#.......#...........#....C.....#',
    '#..cc...#...c...c...#..........#',
    '#..cc.......................cc.#',
    '#.......#...........#.......cc.#',
    '#...C...#####...#####..........#',
    '#..............................#',
    '#.....P.....P.......P......P...#',
    '################################',
  ],
};
