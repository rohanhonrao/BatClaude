// vaultlock.js — a self-contained, per-namespace encrypted vault lock.
//
// Unlike the app's transparent device key (crypto.js `autoUnlock`, which stores
// the key in plaintext beside the data), a vault here is protected by a passcode
// and/or biometric. Its data-encryption key (DEK) is:
//   • randomly generated, never derived from the passcode directly;
//   • only ever written to disk *wrapped* (encrypted) by a KEK from the passcode
//     (PBKDF2, 310k iters) and, optionally, from a biometric (WebAuthn PRF);
//   • held in memory ONLY while unlocked.
// So at rest the data is undecryptable without the passcode or biometric — a real
// security boundary, even to someone with full access to the device's storage.
//
// `makeVault(ns)` returns an isolated vault whose settings keys are `${ns}Meta`
// and `${ns}BioMeta`, so multiple sensitive modules can each have their own lock.
import { db } from './db.js';

const PBKDF2_ITERATIONS = 310000;
const enc = new TextEncoder();
const dec = new TextDecoder();

function rb(n) { return crypto.getRandomValues(new Uint8Array(n)); }
function b64(buf) { return btoa(String.fromCharCode(...new Uint8Array(buf))); }
function unb64(s) { return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); }
async function meta(k) { const r = await db.get('settings', k); return r ? r.value : null; }
function setMeta(k, v) { return db.put('settings', { key: k, value: v }); }
function delMeta(k) { return db.del('settings', k); }

async function pbkdf2KEK(passcode, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', enc.encode(passcode), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function rawKEK(bytes) { return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']); }
function newDEK() { return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']); }
function exportRaw(k) { return crypto.subtle.exportKey('raw', k); }
function importDEK(raw) { return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']); }
async function wrap(kek, dek) {
  const iv = rb(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, kek, await exportRaw(dek));
  return { iv: b64(iv), ct: b64(ct) };
}
async function unwrap(kek, w) {
  const raw = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(w.iv) }, kek, unb64(w.ct));
  return importDEK(new Uint8Array(raw));
}

// WebAuthn PRF — derive a stable high-entropy secret from a platform biometric.
async function prfSecret(credId, salt) {
  const a = await navigator.credentials.get({
    publicKey: {
      challenge: rb(32),
      allowCredentials: [{ type: 'public-key', id: credId }],
      userVerification: 'required', timeout: 60000,
      extensions: { prf: { eval: { first: salt } } },
    },
  });
  const res = a.getClientExtensionResults();
  return (res.prf && res.prf.results && res.prf.results.first) ? new Uint8Array(res.prf.results.first) : null;
}

export function makeVault(ns) {
  const K = { meta: `${ns}Meta`, bio: `${ns}BioMeta` };
  let dek = null; // in-memory CryptoKey; null when locked

  return {
    async isSetUp() { return !!(await meta(K.meta)); },
    isUnlocked() { return !!dek; },
    lock() { dek = null; },

    async setup(passcode) {
      const d = await newDEK();
      const salt = rb(16);
      const kek = await pbkdf2KEK(passcode, salt, PBKDF2_ITERATIONS);
      await setMeta(K.meta, { salt: b64(salt), iterations: PBKDF2_ITERATIONS, wrapped: await wrap(kek, d) });
      dek = d;
      return true;
    },
    async unlock(passcode) {
      const m = await meta(K.meta);
      if (!m) return false;
      try {
        const kek = await pbkdf2KEK(passcode, unb64(m.salt), m.iterations);
        dek = await unwrap(kek, m.wrapped); // throws on wrong passcode
        return true;
      } catch { return false; }
    },
    async changePasscode(passcode) {
      if (!dek) throw new Error('Unlock first');
      const salt = rb(16);
      const kek = await pbkdf2KEK(passcode, salt, PBKDF2_ITERATIONS);
      await setMeta(K.meta, { salt: b64(salt), iterations: PBKDF2_ITERATIONS, wrapped: await wrap(kek, dek) });
      return true;
    },

    bio: {
      async available() {
        try { return !!window.PublicKeyCredential && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(); }
        catch { return false; }
      },
      async enabled() { return !!(await meta(K.bio)); },
      async enable() {
        if (!dek) throw new Error('Unlock first');
        const prfSalt = rb(32);
        const cred = await navigator.credentials.create({
          publicKey: {
            challenge: rb(32),
            rp: { name: 'BatVault', id: location.hostname },
            user: { id: rb(16), name: `batvault-${ns}`, displayName: 'BatVault' },
            pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
            authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
            timeout: 60000, extensions: { prf: {} },
          },
        });
        const credId = new Uint8Array(cred.rawId);
        const secret = await prfSecret(credId, prfSalt);
        if (!secret) throw new Error('This device/browser doesn’t support biometric key unlock.');
        await setMeta(K.bio, { credId: b64(credId), prfSalt: b64(prfSalt), wrapped: await wrap(await rawKEK(secret), dek) });
        return true;
      },
      async disable() { await delMeta(K.bio); },
      async unlock() {
        const m = await meta(K.bio);
        if (!m) return false;
        const secret = await prfSecret(unb64(m.credId), unb64(m.prfSalt));
        if (!secret) return false;
        dek = await unwrap(await rawKEK(secret), m.wrapped);
        return true;
      },
    },

    // Data encryption with the in-memory DEK.
    async encrypt(obj) {
      const iv = rb(12);
      const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, dek, enc.encode(JSON.stringify(obj)));
      return { iv: b64(iv), ct: b64(ct) };
    },
    async decrypt(blob) {
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(blob.iv) }, dek, unb64(blob.ct));
      return JSON.parse(dec.decode(pt));
    },
  };
}
