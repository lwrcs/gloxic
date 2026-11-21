// Binary wire format for the hot path (input commands, snapshots, pings).
// Rare, reliable things (joins, kills, round changes, other players' shots)
// go as JSON text frames instead. WebSocket delivers both in order.
//
// Client -> server
//   CMDS  u8 type, u8 count, count x { u32 seq, u16 buttons, f32 yaw, f32 pitch,
//         u8 slot, u8 spawnId, f32 viewTick }
//   PING  u8 type, f64 clientTime, u16 lastRttMs
// Server -> client
//   SNAP  u8 type, u32 tick, u32 ackSeq, self, u8 count, count x other
//         self  = u8 flags, u8 spawnId, f64 px py pz vx vy vz, u8 health,
//                 u8 slot, u16 ammo, u16 reserve, u16 reloadMs
//         other = u8 id, f32 x y z, u16 yaw, i16 pitch, u8 flags, u8 slot,
//                 u8 health, u16 reserved
//   PONG  u8 type, f64 clientTime, f64 serverTick (fractional)

export const MSG = { CMDS: 1, PING: 2, SNAP: 10, PONG: 11 };

// Entity flags.
export const FLAG = { ALIVE: 1, GROUND: 2, CROUCH: 4, QUIET: 8, PROTECTED: 16, FROZEN: 32 };

const CMD_SIZE = 20;
const OTHER_SIZE = 22;
const SELF_SIZE = 2 + 48 + 8;
const INF = 0xffff;
const TAU = Math.PI * 2;

export function encodeCmds(cmds) {
  const buf = new ArrayBuffer(2 + cmds.length * CMD_SIZE);
  const v = new DataView(buf);
  v.setUint8(0, MSG.CMDS);
  v.setUint8(1, cmds.length);
  let o = 2;
  for (const c of cmds) {
    v.setUint32(o, c.seq >>> 0);
    v.setUint16(o + 4, c.buttons);
    v.setFloat32(o + 6, c.yaw);
    v.setFloat32(o + 10, c.pitch);
    v.setUint8(o + 14, c.slot);
    v.setUint8(o + 15, c.spawnId & 255);
    v.setFloat32(o + 16, c.viewTick);
    o += CMD_SIZE;
  }
  return buf;
}

// Returns null for anything malformed (the server then drops the connection).
export function decodeCmds(v) {
  const n = v.getUint8(1);
  if (n < 1 || n > 32 || v.byteLength !== 2 + n * CMD_SIZE) return null;
  const out = [];
  let o = 2;
  for (let i = 0; i < n; i++) {
    const c = {
      seq: v.getUint32(o),
      buttons: v.getUint16(o + 4),
      yaw: v.getFloat32(o + 6),
      pitch: v.getFloat32(o + 10),
      slot: v.getUint8(o + 14),
      spawnId: v.getUint8(o + 15),
      viewTick: v.getFloat32(o + 16),
    };
    if (!Number.isFinite(c.yaw) || !Number.isFinite(c.pitch) || !Number.isFinite(c.viewTick)) return null;
    out.push(c);
    o += CMD_SIZE;
  }
  return out;
}

export function encodePing(clientTime, rttMs) {
  const v = new DataView(new ArrayBuffer(11));
  v.setUint8(0, MSG.PING);
  v.setFloat64(1, clientTime);
  v.setUint16(9, Math.min(65535, Math.max(0, Math.round(rttMs))));
  return v.buffer;
}

export function decodePing(v) {
  if (v.byteLength !== 11) return null;
  return { clientTime: v.getFloat64(1), rtt: v.getUint16(9) };
}

export function encodePong(clientTime, serverTick) {
  const v = new DataView(new ArrayBuffer(17));
  v.setUint8(0, MSG.PONG);
  v.setFloat64(1, clientTime);
  v.setFloat64(9, serverTick);
  return v.buffer;
}

export function decodePong(v) {
  return { clientTime: v.getFloat64(1), serverTick: v.getFloat64(9) };
}

const enc16 = (n) => (n === Infinity ? INF : Math.min(INF - 1, Math.max(0, Math.round(n))));
const dec16 = (n) => (n === INF ? Infinity : n);
const wrapAngle = (a) => ((a % TAU) + TAU) % TAU;

// self:   { flags, spawnId, position, velocity, health, slot, ammo, reserve, reload }
// others: [{ id, position, yaw, pitch, flags, slot, health }]
export function encodeSnapshot(tick, ackSeq, self, others) {
  const buf = new ArrayBuffer(9 + SELF_SIZE + 1 + others.length * OTHER_SIZE);
  const v = new DataView(buf);
  v.setUint8(0, MSG.SNAP);
  v.setUint32(1, tick);
  v.setUint32(5, ackSeq >>> 0);
  let o = 9;
  v.setUint8(o, self.flags);
  v.setUint8(o + 1, self.spawnId & 255);
  const p = self.position;
  const vel = self.velocity;
  [p.x, p.y, p.z, vel.x, vel.y, vel.z].forEach((n, i) => v.setFloat64(o + 2 + i * 8, n));
  o += 50;
  v.setUint8(o, Math.ceil(Math.max(0, Math.min(255, self.health))));
  v.setUint8(o + 1, self.slot);
  v.setUint16(o + 2, enc16(self.ammo));
  v.setUint16(o + 4, enc16(self.reserve));
  v.setUint16(o + 6, enc16(self.reload * 1000));
  o += 8;
  v.setUint8(o++, others.length);
  for (const e of others) {
    v.setUint8(o, e.id);
    v.setFloat32(o + 1, e.position.x);
    v.setFloat32(o + 5, e.position.y);
    v.setFloat32(o + 9, e.position.z);
    v.setUint16(o + 13, Math.round((wrapAngle(e.yaw) / TAU) * 65535));
    v.setInt16(o + 15, Math.round((Math.max(-1, Math.min(1, e.pitch / (Math.PI / 2)))) * 32767));
    v.setUint8(o + 17, e.flags);
    v.setUint8(o + 18, e.slot);
    v.setUint8(o + 19, Math.ceil(Math.max(0, Math.min(255, e.health))));
    v.setUint16(o + 20, 0);
    o += OTHER_SIZE;
  }
  return buf;
}

export function decodeSnapshot(v) {
  let o = 9;
  const f = (i) => v.getFloat64(o + 2 + i * 8);
  const self = {
    flags: v.getUint8(o),
    spawnId: v.getUint8(o + 1),
    position: { x: f(0), y: f(1), z: f(2) },
    velocity: { x: f(3), y: f(4), z: f(5) },
  };
  o += 50;
  self.health = v.getUint8(o);
  self.slot = v.getUint8(o + 1);
  self.ammo = dec16(v.getUint16(o + 2));
  self.reserve = dec16(v.getUint16(o + 4));
  self.reload = dec16(v.getUint16(o + 6)) / 1000;
  o += 8;
  const count = v.getUint8(o++);
  const others = [];
  for (let i = 0; i < count; i++) {
    others.push({
      id: v.getUint8(o),
      position: { x: v.getFloat32(o + 1), y: v.getFloat32(o + 5), z: v.getFloat32(o + 9) },
      yaw: (v.getUint16(o + 13) / 65535) * TAU,
      pitch: (v.getInt16(o + 15) / 32767) * (Math.PI / 2),
      flags: v.getUint8(o + 17),
      slot: v.getUint8(o + 18),
      health: v.getUint8(o + 19),
    });
    o += OTHER_SIZE;
  }
  return { tick: v.getUint32(1), ackSeq: v.getUint32(5), self, others };
}
