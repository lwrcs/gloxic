# Gloxic

A fast browser FPS made with **Three.js** and **Vite**, written in plain JavaScript. Play 1v1 or team deathmatch with friends using a friend code, or practice against bots. Works with mouse and keyboard or on phones and tablets (on-screen controls; add it to your home screen for fullscreen).

## Run locally

```
npm install
npm run dev            # game at http://localhost:5173
npm run server:dev     # game server at http://localhost:8787 (local Cloudflare runtime)
npm run test:sim       # headless test of the match simulation
```

Without Firebase settings, local play uses dev sign-in: each browser tab is a separate player, so you can test a match with two tabs.

## Architecture

```
browser (GitHub Pages)                         Cloudflare
┌──────────────────────┐   HTTPS  /api/...    ┌────────────────────────────┐
│ Menu / Lobby UI      │ ───────────────────▶ │ Worker (server/src/index)  │
│ Auth (Firebase)      │   ID token in        │  verifies Firebase token,  │
│                      │   Authorization      │  issues signed tickets     │
│                      │                      └──────┬──────────────┬──────┘
│ LobbyClient  ◀──── WebSocket (JSON) ─────────▶ Lobby DO (per code)  │
│ OnlineSession ◀─── WebSocket (binary 64 Hz) ─▶ Match DO (per match, │
│  prediction,         │                         placed in the        │
│  interpolation       │                         fairest region)      │
│ measurePings ─────── GET /probe/<region> ────▶ Probe DO (per region)│
└──────────────────────┘                      └────────────────────────────┘
```

**Services**
- **Hosting:** GitHub Pages serves the static game.
- **Game servers:** Cloudflare Workers + Durable Objects. Each match is one Durable Object running the authoritative simulation in JavaScript, the same code the browser runs. There are no servers to manage, a match starts in milliseconds, and it can be placed in any of nine regions. An idle lobby costs nothing.
- **Accounts:** Firebase Authentication: Google, email / password, or guest (anonymous). The server only verifies signed ID tokens. Player data (stats, friends) can live in Durable Objects or D1 later.

**Matchmaking (friends)**
1. Create a match: the server makes a 6-character friend code (no look-alike characters) and a Lobby object for it. Share the code or the invite link (`?join=CODE`). Friends who open the link land in the lobby, signed in as a guest if needed.
2. In the lobby, every browser measures its ping to each region's Probe (best of 3 after a warm-up) and reports it.
3. The host picks 1v1 or Team Deathmatch and presses Start. The lobby picks the region with the **lowest worst-case ping** (ties go to the lowest total), creates a Match object there, and sends each member a short-lived ticket to join it.
4. When the match ends, everyone is back in the lobby for a rematch. A refreshed tab rejoins a running match automatically.

**Netcode** (shared constants in `src/shared/net.js`)
- **Authoritative server at 64 Hz.** Clients send inputs (buttons and view angles), never positions. The server runs the same player simulation (`src/shared/pawn.js`, movement, weapons) on them.
- **Client-side prediction:** your movement and shots happen instantly. Each snapshot acknowledges your last processed command. If the prediction differs, the client resets to the server state, replays the newer commands, and blends the difference out over a few frames. Prediction normally matches exactly: view angles are rounded to the wire's float32 before simulating.
- **Entity interpolation:** other players are drawn about 2 ticks in the past, between two snapshots. The delay adapts to measured jitter.
- **Lag-compensated hit registration:** each command carries the tick you were looking at. The server keeps 40 ticks of hitbox history and rewinds everyone else to that moment before tracing. You hit what you saw, up to 250 ms of rewind (`MAX_REWIND`); beyond that, high-ping players have to lead.
- **Source-style command processing:** commands run as they arrive, so the server adds no input delay.
- **Binary protocol** for commands and snapshots (`src/shared/protocol.js`). Reliable events (shots, hits, kills, phases) are JSON.
- **Hit feedback is server-confirmed:** tracers and impacts show instantly, but hitmarkers, damage numbers and kills come from the server.

**Security**
- The server is authoritative for movement, fire rate, ammo, reloads, damage and deaths.
- Speed hacks: a client can't run commands faster than real time. There is a 16-command burst allowance; commands beyond it are dropped.
- Inputs are validated (finite numbers, clamped pitch, valid weapon slot, message size limits). Malformed packets close the connection.
- Firebase ID tokens are verified with Google's public keys (issuer, audience and expiry checked). WebSockets use HMAC tickets that are scoped to one lobby or match and expire in 60–120 s.
- The `Origin` check on WebSockets and CORS only allow the game's pages.
- Lobby creation and joining are rate limited per account.
- Enemy health is never sent to clients. Player names are sanitized on the server and only ever inserted into the page as text.
- `DEV_AUTH` (local only, in `server/.dev.vars`) is never set in production.

## Deploy

**One-time setup**
1. **Cloudflare:** create a free account, then run `npx wrangler login`.
2. **Firebase:** create a project (console.firebase.google.com) and add a Web app.
   - Under Authentication > Sign-in method, enable Google, Email/Password and Anonymous.
   - Under Authentication > Settings > Authorized domains, add `<you>.github.io`.
3. **Server config:** set the project id in `server/wrangler.toml` (`FIREBASE_PROJECT_ID`), and make sure `ALLOWED_ORIGINS` includes `https://<you>.github.io`.
4. **Ticket secret:** `npx wrangler secret put TICKET_SECRET -c server/wrangler.toml` (any long random string).
5. **Deploy the server:** `npm run server:deploy`, then note the `https://gloxic-server.<account>.workers.dev` URL.
6. **Site variables:** in the GitHub repo, go to Settings > Secrets and variables > Actions > Variables, and add `VITE_API_URL` (the worker URL) and the four `VITE_FIREBASE_*` values from the Firebase web app config.
7. **Pages:** under Settings > Pages, set Source to "GitHub Actions". Every push to `main` then builds and deploys.

**Costs:** the Workers free plan covers a few hours of matches a day (100k requests per day; incoming WebSocket messages count 20:1). The $5/month paid plan covers far more, at roughly $0.002 per player-hour beyond what's included.

## Layout

```
src/
  main.js               wiring: game, player, systems, menu, sessions
  config.js             gameplay tuning
  shared/               code the browser and the server both run
    pawn.js             player simulation: commands -> movement, weapons
    MapGeometry.js      map grid, colliders, spawns, pathfinding, line of sight
    hitboxes.js         character hitbox table
    raycast.js          hitscan math (ray vs boxes)
    protocol.js         binary wire format
    net.js              netcode constants
    modes.js            game modes (1v1, team deathmatch)
    regions.js          server regions + fairest-region pick
  net/
    OnlineSession.js    prediction, reconciliation, interpolation, server events
    LobbyClient.js      lobby connection
    Auth.js             Firebase accounts (dev accounts locally)
    api.js              HTTP calls, region pings
    config.js           server / Firebase settings (Vite env)
  core/                 Game loop, Input, Events, Audio, Settings
  render/PostFX.js      dithered lighting + outline post-process
  world/                World (rendered MapGeometry), maps/
  physics/collision.js  AABB move-and-slide
  entities/             Entity, Player, RemotePlayer, Bot, Viewmodel
  weapons/              definitions (data), Weapon (ammo, recoil, hitscan, melee)
  systems/              RoundManager (practice), Effects
  ui/                   Menu, HUD, DamageNumbers, TouchControls (phones: joystick, look, buttons)
server/
  wrangler.toml         Worker + Durable Object config
  src/index.js          HTTP routes, CORS, rate limits
  src/auth.js           token verification, tickets, name rules
  src/Lobby.js          friend-code lobby
  src/Match.js          match Durable Object (drives the Sim)
  src/Sim.js            authoritative simulation, lag compensation, snapshots
  src/ServerPlayer.js   server-side player + hitbox history
  src/rules.js          mode rules (rounds, respawns, scoring)
  src/Probe.js          region latency probe
  test-sim.mjs          headless simulation test
```

## Extending

| To add...      | Do this |
|----------------|---------|
| A game mode    | Add it to `src/shared/modes.js` and a rules class to `server/src/rules.js` |
| A weapon       | Add an entry to `weapons/definitions.js`, then add its id to `CONFIG.player.loadout` (works online automatically) |
| A map          | Copy `maps/boxyard.js` and register it in `server/src/Sim.js` `MAPS` and `main.js` |
| A server event | Send JSON from `Sim.js`, handle it in `OnlineSession.onEvent` |
| A sound        | Drop files in `public/sounds/<group>/`, list the set in `audio/sounds.js` |

Open the console and use `window.game` to inspect live state.
