// Netcode constants shared by client and server.
//
// Model (Source / Overwatch style):
//   - The server is authoritative and simulates at TICK_RATE.
//   - Clients send one input command per tick and predict their own movement
//     and shooting immediately. When a snapshot acknowledges a command, the
//     client resets to the server's state and replays its newer commands.
//   - Other players are drawn slightly in the past, interpolated between
//     snapshots, so they move smoothly despite network jitter.
//   - Shots are lag-compensated: each command carries the tick the client
//     was looking at, and the server rewinds everyone else's hitboxes to it
//     (up to MAX_REWIND) before tracing. You hit what you saw.

export const TICK_RATE = 64; // simulation ticks per second (= CONFIG.physics.tickRate)
export const SNAPSHOT_EVERY = 1; // ticks between snapshots (1 = 64 Hz)
export const MAX_REWIND = 0.25; // seconds of lag compensation (more = high ping can hit around corners)
export const HISTORY_TICKS = 40; // hitbox history kept per player (> MAX_REWIND)

// Interpolation delay = one snapshot interval + a jitter margin, adapted to
// the measured arrival jitter, clamped to this range (in ticks).
export const INTERP_MIN_TICKS = 1.5;
export const INTERP_MAX_TICKS = 12;

// Anti speed-hack: a client can't run commands faster than real time. Each
// player earns TICK_RATE commands per second, banking at most this many
// (absorbs a lag spike's burst of late packets).
export const CMD_BURST = 16;

export const MAX_PLAYERS = 10;
export const PROTOCOL_VERSION = 1;
