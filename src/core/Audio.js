import * as THREE from 'three';

// Sound engine (WebAudio, no dependencies).
//
//   Sample sets   lists of audio files (public/sounds/) decoded up front;
//                 play() picks a random variation, never the same twice.
//   3D sound      sounds with a `position` go through an HRTF panner (direction
//                 + distance falloff) and get muffled (low-pass) when a wall
//                 is between them and the listener.
//   Room acoustics  probeRoom() casts rays from the listener at the nearby
//                 surfaces a few times a second. Their distances drive:
//                   - early reflections: one echo tap per direction, delayed
//                     by the round trip to that wall
//                   - late reverb: a generated impulse response whose length
//                     and level follow how big / enclosed the space is
//                 so tight corridors ring short and close, open yards are dry.
//   Procedural    gunshot fallback, beep, knife whoosh / hits, footsteps.

const SPEED_OF_SOUND = 343;
const PROBE_DIRS = (() => {
  // 12 horizontal + 4 upward-diagonal + straight up.
  const dirs = [];
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    dirs.push(new THREE.Vector3(Math.cos(a), 0, Math.sin(a)));
  }
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    dirs.push(new THREE.Vector3(Math.cos(a), 1, Math.sin(a)).normalize());
  }
  dirs.push(new THREE.Vector3(0, 1, 0));
  return dirs;
})();
const PROBE_FAR = 40;
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();

export class Audio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.volume = 0.8; // master volume (settings 'volume')
    this.sets = new Map(); // name -> { buffers: AudioBuffer[], last }
    this.room = { decay: 0.8, wet: 0.25 }; // current reverb settings
    this.listenerPos = new THREE.Vector3();
    this.world = null; // set by the game, used for occlusion + probing
  }

  // The context can exist (suspended) before any click, so samples can be
  // decoded at load time. unlock() resumes it from a user gesture.
  ensureContext() {
    if (this.ctx) return this.ctx;
    const ctx = (this.ctx = new AudioContext());
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    // Limiter: lets the mix be loud without clipping when shots overlap.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.12;
    this.master.connect(limiter).connect(ctx.destination);
    this.noise = this.makeNoise();

    // Reverb bus: everything sends into reverbIn.
    this.reverbIn = ctx.createGain();
    // Late reverb: two convolvers so a new impulse response can crossfade in.
    this.reverbOut = ctx.createGain();
    this.reverbOut.gain.value = this.room.wet;
    this.reverbOut.connect(this.master);
    this.convolvers = [0, 1].map(() => {
      const conv = ctx.createConvolver();
      const gain = ctx.createGain();
      this.reverbIn.connect(conv).connect(gain).connect(this.reverbOut);
      return { conv, gain };
    });
    this.activeConv = 0;
    this.convolvers[0].conv.buffer = this.makeImpulse(this.room.decay);
    this.convolvers[1].gain.gain.value = 0;
    // Early reflections: one delay tap per horizontal quadrant + ceiling.
    this.taps = [0, 1, 2, 3, 4].map(() => {
      const delay = ctx.createDelay(0.5);
      const gain = ctx.createGain();
      const tone = ctx.createBiquadFilter(); // walls soak up highs
      tone.type = 'lowpass';
      tone.frequency.value = 5000;
      gain.gain.value = 0;
      this.reverbIn.connect(delay).connect(tone).connect(gain).connect(this.master);
      return { delay, gain };
    });
    return ctx;
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
  }

  // Browsers only allow audio after a user gesture; call this from a click.
  unlock() {
    this.ensureContext();
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  // True once a click has started audio (sounds queued before that would
  // all burst out at once on unlock).
  get ready() {
    return this.ctx?.state === 'running';
  }

  // ---------- listener & room ----------

  // Call every frame with the camera.
  updateListener(camera) {
    if (!this.ctx) return;
    const L = this.ctx.listener;
    const t = this.ctx.currentTime;
    this.listenerPos.copy(camera.position);
    camera.getWorldDirection(_fwd);
    _up.set(0, 1, 0).applyQuaternion(camera.quaternion);
    if (L.positionX) {
      L.positionX.setTargetAtTime(camera.position.x, t, 0.01);
      L.positionY.setTargetAtTime(camera.position.y, t, 0.01);
      L.positionZ.setTargetAtTime(camera.position.z, t, 0.01);
      L.forwardX.setTargetAtTime(_fwd.x, t, 0.01);
      L.forwardY.setTargetAtTime(_fwd.y, t, 0.01);
      L.forwardZ.setTargetAtTime(_fwd.z, t, 0.01);
      L.upX.setTargetAtTime(_up.x, t, 0.01);
      L.upY.setTargetAtTime(_up.y, t, 0.01);
      L.upZ.setTargetAtTime(_up.z, t, 0.01);
    } else {
      L.setPosition(camera.position.x, camera.position.y, camera.position.z);
      L.setOrientation(_fwd.x, _fwd.y, _fwd.z, _up.x, _up.y, _up.z);
    }
  }

  // Measures the space around `pos` by raycasting at nearby surfaces and
  // retunes the reflections and reverb to match. Call a few times a second.
  probeRoom(world, pos) {
    if (!this.ctx || !world) return;
    const rc = world.raycaster;
    const dists = PROBE_DIRS.map((d) => {
      rc.set(pos, d);
      rc.far = PROBE_FAR;
      const hit = rc.intersectObjects(world.meshes, false)[0];
      return hit ? hit.distance : Infinity;
    });
    const horiz = dists.slice(0, 12);
    const upward = dists.slice(12);
    const hitH = horiz.filter(Number.isFinite);
    const meanH = hitH.length ? hitH.reduce((a, b) => a + b, 0) / hitH.length : PROBE_FAR;
    // How boxed-in we are: share of upward rays that hit something.
    const enclosure = upward.filter(Number.isFinite).length / upward.length;
    const closeness = Math.max(0, 1 - meanH / 25); // 1 = walls right here

    // Late reverb: bigger spaces ring longer; walls all around ring louder.
    const decay = THREE.MathUtils.clamp(0.35 + meanH * 0.07, 0.35, 2.4) * (0.8 + enclosure * 0.4);
    const wet = THREE.MathUtils.clamp(0.1 + closeness * 0.25 + enclosure * 0.25, 0.08, 0.55);
    this.setRoom(decay, wet);

    // Early reflections: nearest wall in each horizontal quadrant + ceiling.
    const t = this.ctx.currentTime;
    for (let q = 0; q < 4; q++) {
      const d = Math.min(horiz[q * 3], horiz[q * 3 + 1], horiz[q * 3 + 2]);
      this.setTap(this.taps[q], d, t);
    }
    this.setTap(this.taps[4], dists[16], t);
  }

  setTap(tap, dist, t) {
    if (!Number.isFinite(dist)) {
      tap.gain.gain.setTargetAtTime(0, t, 0.1);
      return;
    }
    tap.delay.delayTime.setTargetAtTime(Math.min(0.45, (2 * dist) / SPEED_OF_SOUND), t, 0.1);
    tap.gain.gain.setTargetAtTime(0.35 / (1 + dist / 3), t, 0.1);
  }

  setRoom(decay, wet) {
    const t = this.ctx.currentTime;
    this.reverbOut.gain.setTargetAtTime(wet, t, 0.2);
    this.room.wet = wet;
    // Only rebuild the impulse when the size really changed (it costs a bit).
    if (Math.abs(decay - this.room.decay) / this.room.decay < 0.15) return;
    this.room.decay = decay;
    const next = 1 - this.activeConv;
    const a = this.convolvers[this.activeConv];
    const b = this.convolvers[next];
    b.conv.buffer = this.makeImpulse(decay);
    a.gain.gain.setTargetAtTime(0, t, 0.15);
    b.gain.gain.setTargetAtTime(1, t, 0.15);
    this.activeConv = next;
  }

  // Stereo decaying noise, darker toward the tail (air + wall absorption).
  makeImpulse(decay) {
    const rate = this.ctx.sampleRate;
    const len = Math.max(1, Math.floor(rate * decay));
    const buf = this.ctx.createBuffer(2, len, rate);
    for (let c = 0; c < 2; c++) {
      const data = buf.getChannelData(c);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const x = i / len;
        const env = Math.pow(1 - x, 2) * Math.exp((-6.9 * i) / len);
        const k = 0.9 - x * 0.75; // low-pass gets stronger over time
        lp += k * (Math.random() * 2 - 1 - lp);
        data[i] = lp * env;
      }
    }
    return buf;
  }

  // ---------- routing ----------

  // Builds the path for one sound and returns its input node.
  //   position - world position (3D: panned, distance falloff, occlusion);
  //              omit for your own sounds (centered, no falloff)
  //   volume   - gain
  //   reverb   - how much goes to the room (0..1, default 1)
  route({ position = null, volume = 1, reverb = 1 } = {}) {
    const ctx = this.ctx;
    const input = ctx.createGain();
    input.gain.value = volume;
    let out = input;
    if (position) {
      const occluded = this.world && !this.world.hasLineOfSight(this.listenerPos, position);
      if (occluded) {
        const muffle = ctx.createBiquadFilter();
        muffle.type = 'lowpass';
        muffle.frequency.value = 700;
        const g = ctx.createGain();
        g.gain.value = 0.55;
        out = out.connect(muffle).connect(g);
      }
      const p = ctx.createPanner();
      p.panningModel = 'HRTF';
      p.distanceModel = 'inverse';
      p.refDistance = 3;
      p.rolloffFactor = 1.1;
      p.maxDistance = 120;
      if (p.positionX) {
        p.positionX.value = position.x;
        p.positionY.value = position.y;
        p.positionZ.value = position.z;
      } else p.setPosition(position.x, position.y, position.z);
      out = out.connect(p);
      // Distant sounds are relatively more reverberant.
      const dist = position.distanceTo(this.listenerPos);
      reverb *= Math.min(2, 1 + dist / 30);
    }
    out.connect(this.master);
    if (reverb > 0) {
      const send = ctx.createGain();
      send.gain.value = reverb;
      out.connect(send).connect(this.reverbIn);
    }
    return input;
  }

  // ---------- samples ----------

  // Loads a named set of sample variations. Files that fail are skipped.
  async loadSet(name, urls) {
    const ctx = this.ensureContext();
    const results = await Promise.allSettled(
      urls.map(async (url) => {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`${res.status} ${url}`);
        return ctx.decodeAudioData(await res.arrayBuffer());
      }),
    );
    const buffers = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    results.filter((r) => r.status === 'rejected').forEach((r) => console.warn('Sound failed to load:', r.reason));
    if (buffers.length) this.sets.set(name, { buffers, last: -1 });
    return buffers.length;
  }

  hasSet(name) {
    return this.sets.has(name);
  }

  // Plays a random variation from a loaded set.
  //   position / reverb - see route()
  //   delay - optional: seconds from now to start
  //   endIn - optional: delay the start so the sound finishes this many
  //           seconds from now (e.g. a reload rack landing as it completes)
  // Returns a handle with stop(), or null if the set isn't loaded (yet), so
  // callers can fall back to a procedural sound.
  play(name, { volume = 1, pitch = 1, delay: startDelay = 0, endIn = null, position = null, reverb = 1 } = {}) {
    const set = this.sets.get(name);
    if (!set || !this.ready) return null;
    if (volume <= 0.005) return { stop() {} };
    let i = Math.floor(Math.random() * set.buffers.length);
    if (set.buffers.length > 1 && i === set.last) i = (i + 1) % set.buffers.length;
    set.last = i;
    const buffer = set.buffers[i];
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = pitch;
    src.connect(this.route({ position, volume, reverb }));
    const delay = endIn == null ? startDelay : Math.max(0, endIn - buffer.duration / pitch);
    src.start(this.ctx.currentTime + delay);
    return {
      stop: () => {
        try {
          src.stop();
        } catch {
          /* already stopped */
        }
      },
    };
  }

  // ---------- procedural ----------

  makeNoise() {
    const len = this.ctx.sampleRate;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  // Filtered noise burst: the building block for the procedural sounds.
  noiseBurst(dest, t, { type = 'bandpass', from, to, q = 1, dur, gain }) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(from, t);
    f.frequency.exponentialRampToValueAtTime(to, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + Math.min(0.01, dur * 0.2));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(dest);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.02);
  }

  gunshot({ volume = 1, pitch = 1, position = null } = {}) {
    if (!this.ready || volume <= 0.01) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const dest = this.route({ position, volume });
    this.noiseBurst(dest, t, { type: 'lowpass', from: 4000 * pitch, to: 300, dur: 0.18, gain: 1 });
    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(160 * pitch, t);
    osc.frequency.exponentialRampToValueAtTime(40, t + 0.1);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.8, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    osc.connect(og).connect(dest);
    osc.start(t);
    osc.stop(t + 0.13);
  }

  // Knife swipe: a fast swept "whoosh". variant 0..3 changes the sweep.
  whoosh({ variant = 0, volume = 0.5, position = null } = {}) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const dest = this.route({ position, volume, reverb: 0.4 });
    const r = 0.85 + Math.random() * 0.3;
    const shapes = [
      { from: 700, to: 2600, dur: 0.16 }, // rising slash
      { from: 2600, to: 650, dur: 0.17 }, // falling slash
      { from: 1200, to: 3400, dur: 0.11 }, // quick jab
      { from: 500, to: 1800, dur: 0.22 }, // heavy overhead (backstab)
    ];
    const s = shapes[variant % shapes.length];
    this.noiseBurst(dest, t, { from: s.from * r, to: s.to * r, q: 1.6, dur: s.dur, gain: 0.9 });
  }

  // Knife connecting: 'flesh' (dull thud) or 'wall' (bright tick).
  impact({ kind = 'flesh', volume = 0.7, position = null } = {}) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const dest = this.route({ position, volume, reverb: 0.6 });
    if (kind === 'flesh') {
      this.noiseBurst(dest, t, { type: 'lowpass', from: 900, to: 120, dur: 0.12, gain: 1 });
      this.noiseBurst(dest, t, { from: 2200, to: 1400, q: 3, dur: 0.05, gain: 0.4 });
    } else {
      this.noiseBurst(dest, t, { type: 'highpass', from: 3500, to: 2500, dur: 0.06, gain: 0.8 });
      this.noiseBurst(dest, t, { from: 900, to: 600, q: 4, dur: 0.08, gain: 0.5 });
    }
  }

  // One footstep on hard ground: low thump + scuff, randomized.
  //   foot - -1 left / 1 right (your own steps are panned slightly)
  footstep({ volume = 0.35, position = null, foot = 1, heavy = false } = {}) {
    if (!this.ready || volume <= 0.005) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    let dest = this.route({ position, volume, reverb: 0.7 });
    if (!position) {
      const pan = ctx.createStereoPanner();
      pan.pan.value = foot * 0.15;
      pan.connect(dest);
      dest = pan;
    }
    const r = 0.85 + Math.random() * 0.3;
    this.noiseBurst(dest, t, { type: 'lowpass', from: 420 * r, to: 90, dur: heavy ? 0.16 : 0.09, gain: heavy ? 1 : 0.8 });
    this.noiseBurst(dest, t + 0.008, { from: 2600 * r, to: 1700 * r, q: 2.5, dur: 0.05, gain: 0.25 });
  }

  beep(freq = 1200, duration = 0.04, volume = 0.3, type = 'square') {
    if (!this.ready) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(volume, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + duration);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + duration + 0.01);
  }
}
