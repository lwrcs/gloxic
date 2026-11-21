// Tiny pub/sub bus. Systems talk to each other through events so they stay
// decoupled: weapons emit 'shot', entities emit 'damage' / 'death', the
// round manager emits 'roundStart' / 'roundEnd', and the HUD, effects and
// audio just listen.

export class Events {
  constructor() {
    this.listeners = new Map();
  }

  on(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
    return () => this.off(type, fn);
  }

  off(type, fn) {
    this.listeners.get(type)?.delete(fn);
  }

  emit(type, payload) {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const fn of [...set]) fn(payload);
  }
}
