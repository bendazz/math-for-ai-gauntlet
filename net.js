/* net.js — the game's only connection to shared state.

   Two interchangeable backends with the same small API:
     firebase — Realtime Database + anonymous sign-in (the real thing, config in firebase-config.js)
     local    — one browser only: localStorage + BroadcastChannel between tabs. Add ?local to the URL.
                For rehearsing a game on one computer, and for testing without Firebase.

   API: { mode, uid, now(), on(path, cb) -> unsubscribe, get(path), set(path, value),
          update(path, patch), remove(path), serverTime } */

import { FIREBASE_CONFIG } from "./firebase-config.js";

const SDK = "https://www.gstatic.com/firebasejs/12.19.0";

export const LOCAL = new URLSearchParams(location.search).has("local");

export async function connect() {
  if (LOCAL) return localBackend();
  if (!FIREBASE_CONFIG || !FIREBASE_CONFIG.apiKey) {
    throw new Error("Firebase isn't set up yet: paste your config into firebase-config.js (or add ?local to try it on one computer).");
  }
  return firebaseBackend(FIREBASE_CONFIG);
}

// ------------------------------------------------------------------ Firebase
async function firebaseBackend(config) {
  const [{ initializeApp }, authMod, dbMod] = await Promise.all([
    import(`${SDK}/firebase-app.js`),
    import(`${SDK}/firebase-auth.js`),
    import(`${SDK}/firebase-database.js`),
  ]);
  const app = initializeApp(config);
  const auth = authMod.getAuth(app);
  const cred = await authMod.signInAnonymously(auth);
  const db = dbMod.getDatabase(app);
  const { ref, onValue, get, set, update, remove, serverTimestamp } = dbMod;

  let offset = 0;
  onValue(ref(db, ".info/serverTimeOffset"), (s) => { offset = s.val() || 0; });

  return {
    mode: "firebase",
    uid: cred.user.uid,
    now: () => Date.now() + offset,
    serverTime: serverTimestamp(),
    on(path, cb) { return onValue(ref(db, path), (s) => cb(s.val())); },
    async get(path) { return (await get(ref(db, path))).val(); },
    set: (path, value) => set(ref(db, path), value),
    update: (path, patch) => update(ref(db, path), patch),
    remove: (path) => remove(ref(db, path)),
  };
}

// ------------------------------------------------------------------ local (one browser)
function localBackend() {
  const KEY = "gauntlet-local-db";
  const chan = new BroadcastChannel("gauntlet-local");
  const listeners = new Set();

  let uid = sessionStorage.getItem("gauntlet-local-uid");
  if (!uid) {
    uid = "local-" + Math.random().toString(36).slice(2, 10);
    sessionStorage.setItem("gauntlet-local-uid", uid);
  }

  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; } };
  const parts = (path) => path.split("/").filter(Boolean);
  const read = (tree, path) => parts(path).reduce((n, k) => (n == null ? null : n[k] ?? null), tree);

  function write(path, fn) {
    const tree = load();
    const ks = parts(path);
    let node = tree;
    for (const k of ks.slice(0, -1)) node = node[k] = (node[k] && typeof node[k] === "object") ? node[k] : {};
    fn(node, ks[ks.length - 1]);
    localStorage.setItem(KEY, JSON.stringify(prune(tree) || {}));
    chan.postMessage("changed");
    notify();
    return Promise.resolve();
  }
  // mimic Firebase: empty objects and nulls disappear
  function prune(x) {
    if (x === null || x === undefined) return null;
    if (typeof x !== "object") return x;
    const out = {};
    for (const [k, v] of Object.entries(x)) { const p = prune(v); if (p !== null) out[k] = p; }
    return Object.keys(out).length ? out : null;
  }
  function notify() {
    const tree = load();
    for (const l of listeners) {
      const val = read(tree, l.path);
      const json = JSON.stringify(val);
      if (json !== l.last) { l.last = json; l.cb(val == null ? null : JSON.parse(json)); }
    }
  }
  // Another tab's localStorage write can reach this tab a moment after its broadcast does,
  // so re-check shortly after each message, and on the storage event (which fires only once
  // the new value is readable here).
  chan.onmessage = () => { notify(); setTimeout(notify, 60); setTimeout(notify, 400); };
  window.addEventListener("storage", (e) => { if (e.key === KEY) notify(); });

  return {
    mode: "local",
    uid,
    now: () => Date.now(),
    get serverTime() { return Date.now(); },
    on(path, cb) {
      const l = { path, cb, last: undefined };
      listeners.add(l);
      setTimeout(notify, 0);
      return () => listeners.delete(l);
    },
    async get(path) { return read(load(), path); },
    set: (path, value) => write(path, (node, k) => { node[k] = value; }),
    update: (path, patch) => {
      // Firebase multi-path update: each key may itself be a path
      const tree = load();
      for (const [sub, value] of Object.entries(patch)) {
        const ks = parts(path + "/" + sub);
        let node = tree;
        for (const k of ks.slice(0, -1)) node = node[k] = (node[k] && typeof node[k] === "object") ? node[k] : {};
        node[ks[ks.length - 1]] = value;
      }
      localStorage.setItem(KEY, JSON.stringify(prune(tree) || {}));
      chan.postMessage("changed");
      notify();
      return Promise.resolve();
    },
    remove: (path) => write(path, (node, k) => { delete node[k]; }),
  };
}
