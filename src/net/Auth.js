import { FIREBASE_CONFIG } from './config.js';

// Accounts, through Firebase Authentication: Google, email + password, or
// guest (anonymous; a real account id without any details, so friends can
// jump straight in). The server only ever sees a signed ID token.
//
// Without a Firebase config (local development) it uses dev accounts: a
// random id per browser tab (so two tabs are two players) that the local
// server accepts.

const NAME_KEY = 'gloxic.name';

export class Auth {
  constructor() {
    this.user = null; // { uid, guest, email, provider }
    this.mode = FIREBASE_CONFIG ? 'firebase' : 'dev';
    this.listeners = new Set();
    this.ready = this.init();
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    for (const fn of this.listeners) fn(this.user);
  }

  get name() {
    try {
      return localStorage.getItem(NAME_KEY) || '';
    } catch {
      return '';
    }
  }

  set name(v) {
    try {
      localStorage.setItem(NAME_KEY, v);
    } catch {
      /* ignore */
    }
  }

  async init() {
    if (this.mode === 'dev') {
      // The server names dev accounts "dev-<id>"; match it so host checks work.
      const id = sessionStorage.getItem('gloxic.devUid');
      this.user = id ? { uid: `dev-${id}`, devId: id, guest: true, provider: 'dev' } : null;
      this.emit();
      return;
    }
    const [{ initializeApp }, fb] = await Promise.all([import('firebase/app'), import('firebase/auth')]);
    this.fb = fb;
    this.auth = fb.getAuth(initializeApp(FIREBASE_CONFIG));
    await new Promise((resolve) => {
      fb.onAuthStateChanged(this.auth, (u) => {
        this.user = u
          ? { uid: u.uid, guest: u.isAnonymous, email: u.email, provider: u.isAnonymous ? 'guest' : (u.providerData[0]?.providerId ?? 'password') }
          : null;
        if (u?.displayName && !this.name) this.name = u.displayName;
        this.emit();
        resolve();
      });
    });
  }

  async ensureSignedIn() {
    await this.ready;
    if (!this.user) await this.signInGuest();
  }

  async signInGuest() {
    await this.ready;
    if (this.mode === 'dev') {
      const id = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');
      sessionStorage.setItem('gloxic.devUid', id);
      this.user = { uid: `dev-${id}`, devId: id, guest: true, provider: 'dev' };
      this.emit();
      return;
    }
    await this.fb.signInAnonymously(this.auth);
  }

  async signInGoogle() {
    await this.ready;
    if (this.mode === 'dev') return this.signInGuest();
    const provider = new this.fb.GoogleAuthProvider();
    // A guest who signs in keeps their account (it gets upgraded).
    const current = this.auth.currentUser;
    if (current?.isAnonymous) {
      try {
        await this.fb.linkWithPopup(current, provider);
        await current.reload();
        this.user = { ...this.user, guest: false, provider: 'google.com', email: current.email };
        this.emit();
        return;
      } catch (err) {
        if (err.code !== 'auth/credential-already-in-use') throw err;
      }
    }
    await this.fb.signInWithPopup(this.auth, provider);
  }

  async signInEmail(email, password, create = false) {
    await this.ready;
    if (this.mode === 'dev') return this.signInGuest();
    const fb = this.fb;
    if (create) {
      const current = this.auth.currentUser;
      if (current?.isAnonymous) {
        await fb.linkWithCredential(current, fb.EmailAuthProvider.credential(email, password));
        this.user = { ...this.user, guest: false, provider: 'password', email };
        this.emit();
        return;
      }
      await fb.createUserWithEmailAndPassword(this.auth, email, password);
    } else {
      await fb.signInWithEmailAndPassword(this.auth, email, password);
    }
  }

  async signOut() {
    await this.ready;
    if (this.mode === 'dev') {
      sessionStorage.removeItem('gloxic.devUid');
      this.user = null;
      this.emit();
      return;
    }
    await this.fb.signOut(this.auth);
  }

  // Bearer token for the game server.
  async token() {
    await this.ensureSignedIn();
    if (this.mode === 'dev') return `dev.${this.user.devId}`;
    return this.auth.currentUser.getIdToken();
  }
}

// Friendlier messages for common Firebase errors.
export function authErrorMessage(err) {
  const map = {
    'auth/invalid-credential': 'Wrong email or password',
    'auth/invalid-email': 'That email address looks wrong',
    'auth/email-already-in-use': 'That email already has an account (sign in instead)',
    'auth/weak-password': 'Use a password of at least 6 characters',
    'auth/popup-closed-by-user': 'Sign-in window closed',
    'auth/popup-blocked': 'The browser blocked the sign-in window',
    'auth/network-request-failed': 'Network error, check your connection',
    'auth/configuration-not-found': 'Sign-in is not set up on the server yet (Firebase Authentication is off)',
    'auth/operation-not-allowed': 'That sign-in method is turned off in Firebase',
    'auth/admin-restricted-operation': 'Guest sign-in is turned off in Firebase (enable Anonymous)',
    'auth/unauthorized-domain': 'This site is not on the Firebase authorized domains list',
  };
  return map[err?.code] ?? err?.message ?? String(err);
}
