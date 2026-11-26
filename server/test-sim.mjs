// Plain-Node smoke test of the match simulation (no Cloudflare needed).
import { Sim } from './src/Sim.js';
import { encodeCmds, encodePing, decodeSnapshot, MSG } from '../src/shared/protocol.js';
import { BTN, aimDirection } from '../src/shared/pawn.js';

const fakeWs = (name) => ({ name, msgs: [], snaps: [], send(m) { if (typeof m === 'string') this.msgs.push(JSON.parse(m)); else this.snaps.push(decodeSnapshot(new DataView(m))); }, close(c, r) { this.closed = [c, r]; } });
let ended = null;
const sim = new Sim({ matchId: 'x', lobby: 'ABCDEF', mode: 'duel', map: 'boxyard', region: 'weur', roster: [{ uid: 'a', name: 'Alice', team: 'blue' }, { uid: 'b', name: 'Bob', team: 'red' }] }, { onEnd: (r) => (ended = r) });
const A = fakeWs('A'), B = fakeWs('B');
sim.connect('a', A); sim.connect('b', B);
let t = 0; const adv = (n) => { for (let i = 0; i < n; i++) { t += 1000 / 64; sim.advance(t); } };
adv(64 * 2);
console.log('phase', sim.phase, 'tick', sim.tick, 'msgs A', A.msgs.map((m) => m.t).join(','));
adv(64 * 3); // freeze over
console.log('phase', sim.phase);
const pa = sim.players.get('a'), pb = sim.players.get('b');
// Teleport B in front of A (both on open ground), let history fill.
pa.position.set(0, 0, 17); pb.position.set(-10, 0, 17); pb.yaw = 0;
adv(10);
// A aims at B's head, as seen 4 ticks ago (lag comp), then B moves away.
const viewTick = sim.tick - 4;
const eye = pa.eyePosition; const head = { x: -10, y: 1.65, z: 17 };
const dx = head.x - eye.x, dy = head.y - eye.y, dz = head.z - eye.z; const L = Math.hypot(dx, dy, dz);
const yaw = Math.fround(Math.atan2(-dx / L, -dz / L)), pitch = Math.fround(Math.asin(dy / L));
pb.position.set(-10, 0, 20); // B has since moved 3 m sideways (but history at viewTick says x=0)
const seq = pa.lastSeq + 1;
sim.onMessage('a', A, encodeCmds([{ seq, buttons: BTN.FIRE | BTN.FIRE_PRESS | BTN.RECOIL_VIEW, yaw, pitch, slot: 0, spawnId: pa.spawnId, viewTick }]));
console.log('B health after lag-comp headshot:', pb.health, 'alive', pb.alive, 'A hit msgs', A.msgs.filter((m) => m.t === 'hit'), 'B saw shot', B.msgs.some((m) => m.t === 'shot'));
adv(64 * 4);
console.log('phase', sim.phase, sim.phaseInfo, 'score', sim.score);
// Speed hack: 200 cmds at once -> only the bank's worth run.
const before = pa.lastSeq; const startPos = pa.position.clone();
adv(64 * 3); // freeze over again
const cmds = []; for (let i = 1; i <= 30; i++) cmds.push({ seq: pa.lastSeq + i, buttons: BTN.FORWARD, yaw: 0, pitch: 0, slot: 0, spawnId: pa.spawnId, viewTick: sim.tick });
const p0 = pa.position.clone(); sim.onMessage('a', A, encodeCmds(cmds));
console.log('ran', (p0.distanceTo(pa.position) / (7.44 / 64)).toFixed(1), 'cmds worth of movement out of 30 sent (bank 16)');
const s = A.snaps.at(-1); console.log('snapshot: tick', s.tick, 'ack', s.ackSeq, 'others', s.others.length, 'enemy health hidden', s.others[0].health === 0);
console.log('LOS 0,1.6,10 -> 0,1.6,0:', sim.world.hasLineOfSight({x:0,y:1.6,z:10},{x:0,y:1.6,z:0}));
console.log('shot msg', JSON.stringify(B.msgs.find((m) => m.t === 'shot')));

// ---- Team deathmatch: respawn + spawn protection + score ----
{
  const sim = new Sim({ matchId: 'y', lobby: 'ABCDEF', mode: 'tdm', map: 'boxyard', region: 'weur', roster: [{ uid: 'a', name: 'A', team: 'blue' }, { uid: 'b', name: 'B', team: 'red' }] });
  const A = fakeWs('A'), B = fakeWs('B');
  sim.connect('a', A); sim.connect('b', B);
  let t = 0; const adv = (n) => { for (let i = 0; i < n; i++) { t += 1000 / 64; sim.advance(t); } };
  adv(64 * 6);
  const pa = sim.players.get('a'), pb = sim.players.get('b');
  console.log('TDM phase', sim.phase);
  sim.damage(pb, 200, { source: pa, part: 'body', weapon: { id: 'rifle' } });
  console.log('TDM after kill: score', sim.score, 'B alive', pb.alive);
  adv(64 * 3 + 2);
  console.log('TDM respawned', pb.alive, 'protected', pb.isProtected, 'spawnId', pb.spawnId);
  sim.damage(pb, 50, { source: pa, part: 'body' });
  console.log('TDM protected hit ignored: health', pb.health);
  adv(64 * 2);
  sim.damage(pb, 50, { source: pa, part: 'body' });
  console.log('TDM after protection: health', pb.health);
}

// ---- Security: message flood closes the socket; unknown mode / map fall back ----
{
  const sim = new Sim({ matchId: 'z', lobby: 'ABCDEF', mode: 'constructor', map: '__proto__', region: 'weur', roster: [{ uid: 'a', name: 'A', team: 'blue' }, { uid: 'b', name: 'B', team: 'red' }] });
  if (sim.mode.id !== 'duel') throw new Error('prototype-key mode was not rejected');
  const A = fakeWs('A');
  sim.connect('a', A);
  const ping = encodePing(1, 10);
  for (let i = 0; i < 300; i++) sim.onMessage('a', A, ping);
  if (A.closed) throw new Error('normal message rate closed the socket');
  for (let i = 0; i < 300; i++) sim.onMessage('a', A, ping);
  if (!A.closed || A.closed[0] !== 1008) throw new Error('message flood was not stopped');
  console.log('flood closed socket:', A.closed, '| bad mode fell back to', sim.mode.id);
}

// ---- Bomb: plant, fuse, defuse, explosion, side swap ----
{
  const roster = [{ uid: 'a', name: 'A', team: 'blue' }, { uid: 'b', name: 'B', team: 'red' }, { uid: 'c', name: 'C', team: 'red' }];
  let ended = null;
  const sim = new Sim({ matchId: 'w', lobby: 'ABCDEF', mode: 'bomb', map: 'sandhollow', region: 'weur', roster }, { onEnd: (r) => (ended = r) });
  if (sim.world.def.name !== 'Sandhollow') throw new Error('bomb mode did not load Sandhollow');
  const socks = Object.fromEntries(roster.map((r) => [r.uid, fakeWs(r.uid)]));
  for (const r of roster) sim.connect(r.uid, socks[r.uid]);
  let t = 0; const adv = (n) => { for (let i = 0; i < n; i++) { t += 1000 / 64; sim.advance(t); } };
  adv(64 * 2);
  const A = sim.players.get('a'), B = sim.players.get('b'), C = sim.players.get('c');
  if (sim.phase !== 'freeze' || sim.rules.attack !== 'blue') throw new Error('bomb round did not start');
  if (sim.rules.bomb.carrier !== A) throw new Error('the only attacker should carry the bomb');
  adv(64 * 6); // freeze over
  if (sim.phase !== 'live') throw new Error('not live');
  // Walk A to site A by teleport, then hold Use.
  const spot = sim.world.randomSitePoint('A');
  A.position.copy(spot); A.velocity.set(0, 0, 0);
  const send = (p, ws, buttons, n) => {
    for (let i = 0; i < n; i++) {
      sim.onMessage(p.uid, ws, encodeCmds([{ seq: p.lastSeq + 1, buttons, yaw: 0, pitch: 0, slot: 0, spawnId: p.spawnId, viewTick: sim.tick }]));
      adv(1);
    }
  };
  send(A, socks.a, 0, 10); // settle onto the floor
  const before = A.position.clone();
  send(A, socks.a, BTN.USE | BTN.FORWARD, 64 * 3 + 30);
  console.log('bomb state after 3.6 s of Use in site A:', sim.rules.bomb.state, 'site', sim.rules.bomb.site, '| moved while planting:', before.distanceTo(A.position).toFixed(3));
  if (!sim.rules.bomb.planted) throw new Error('plant failed');
  if (!socks.a.msgs.some((m) => m.t === 'action' && m.kind === 'plant')) throw new Error('planter got no action message');
  if (!socks.b.msgs.some((m) => m.t === 'bomb' && m.reason === 'planted')) throw new Error('defenders not told about the plant');
  // Attacker dies after plant: round goes on.
  sim.damage(A, 999, { source: B });
  if (sim.phase !== 'live') throw new Error('round ended although the bomb is planted');
  // B defuses.
  const bp = sim.rules.bomb.position;
  B.position.set(bp.x + 0.5, bp.y, bp.z);
  send(B, socks.b, 0, 5);
  send(B, socks.b, BTN.USE, 64 * 6 + 20);
  console.log('after defuse attempt:', sim.rules.bomb.state, 'phase', sim.phase, sim.phaseInfo.reason, 'score', sim.score);
  if (sim.score.red !== 1) throw new Error('defuse did not win the round');
  // Fast-forward rounds: let the clock run out to reach the half.
  while (sim.rules.round < 7 && t < 1e9) adv(64);
  adv(64);
  console.log('round', sim.rules.round, 'attack', sim.rules.attack, 'score', sim.score, 'phase', sim.phase);
  if (sim.rules.round !== 7 || sim.rules.attack !== 'red') throw new Error('sides did not swap at half');
  // Explosion: red (now attacking) plants; blue stands near and dies.
  const carrier = sim.rules.bomb.carrier;
  adv(64 * 6);
  const ws = socks[carrier.uid];
  carrier.position.copy(sim.world.randomSitePoint('B'));
  send(carrier, ws, 0, 5);
  send(carrier, ws, BTN.USE, 64 * 3 + 30);
  A.position.set(carrier.position.x + 3, carrier.position.y, carrier.position.z);
  adv(64 * 41);
  console.log('explosion: bomb', sim.rules.bomb.state, 'A alive', A.alive, 'reason', sim.phaseInfo.reason, 'score', sim.score);
  if (sim.rules.bomb.state !== 'exploded' || A.alive) throw new Error('explosion failed');
  console.log('BOMB TESTS PASSED');
}
