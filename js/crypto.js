// crypto.js — client-side encryption for the vault (envelope model).
//
// A random Data Encryption Key (DEK) encrypts all vault data. The DEK is then
// wrapped (encrypted) independently by up to three Key Encryption Keys (KEKs):
//   • password KEK  — PBKDF2(master password)
//   • recovery KEK  — HKDF(recovery key)   [2-of-3 Shamir shares, see shamir.js]
//   • biometric KEK — WebAuthn PRF secret
// Any wrapper can release the DEK, so changing the password (or recovering)
// only re-wraps the DEK — it never re-encrypts your data. The DEK lives in
// memory only while unlocked; only ciphertext is ever written to disk.
import { db } from './db.js';
import { split, combine, encodeShare, decodeShare } from './shamir.js';

const PBKDF2_ITERATIONS = 310000;
const enc = new TextEncoder();
const dec = new TextDecoder();

let vaultKey = null; // the DEK (CryptoKey), in-memory only

// --- helpers ----------------------------------------------------------------
export function randomBytes(n) { return crypto.getRandomValues(new Uint8Array(n)); }
function b64(buf) { return btoa(String.fromCharCode(...new Uint8Array(buf))); }
function unb64(str) { return Uint8Array.from(atob(str), (c) => c.charCodeAt(0)); }

async function pbkdf2KEK(password, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function hkdfKEK(secretBytes, salt) {
  const base = await crypto.subtle.importKey('raw', secretBytes, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode('batvault') },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function rawKEK(secretBytes) {
  return crypto.subtle.importKey('raw', secretBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

function newDEK() { return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']); }
function exportRaw(key) { return crypto.subtle.exportKey('raw', key); }
function importDEK(raw) { return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']); }

async function wrap(kek, dek) {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, kek, await exportRaw(dek));
  return { iv: b64(iv), ct: b64(ct) };
}
async function unwrap(kek, wrapped) {
  const raw = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(wrapped.iv) }, kek, unb64(wrapped.ct));
  return importDEK(new Uint8Array(raw));
}

// --- data encryption (uses the DEK) ----------------------------------------
export async function encryptJSON(obj, key = vaultKey) {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj)));
  return { iv: b64(iv), ct: b64(ct) };
}
export async function decryptJSON(blob, key = vaultKey) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(blob.iv) }, key, unb64(blob.ct));
  return JSON.parse(dec.decode(pt));
}

// --- state ------------------------------------------------------------------
async function meta(k) { const r = await db.get('settings', k); return r ? r.value : null; }
export async function isInitialized() { return !!(await meta('vaultMeta')); }
export function isUnlocked() { return !!vaultKey; }
export function getKey() { return vaultKey; }
export function lock() { vaultKey = null; }

// Interim (pre-lock): transparently unlock with a device-stored key so modules
// work before the master-password layer is added later. This encrypts data at
// rest but is NOT a security boundary on its own (the key sits beside the data).
export async function autoUnlock() {
  if (vaultKey) return;
  const m = await meta('deviceDEK');
  if (m) { vaultKey = await importDEK(unb64(m)); return; }
  const dek = await newDEK();
  await db.put('settings', { key: 'deviceDEK', value: b64(await exportRaw(dek)) });
  vaultKey = dek;
}

// --- master password --------------------------------------------------------
export async function setupMaster(password) {
  const dek = await newDEK();
  const salt = randomBytes(16);
  const kek = await pbkdf2KEK(password, salt, PBKDF2_ITERATIONS);
  const wrapped = await wrap(kek, dek);
  await db.put('settings', { key: 'vaultMeta', value: { salt: b64(salt), iterations: PBKDF2_ITERATIONS, wrapped } });
  vaultKey = dek;
  return true;
}

export async function unlockMaster(password) {
  const m = await meta('vaultMeta');
  if (!m) return false;
  try {
    const kek = await pbkdf2KEK(password, unb64(m.salt), m.iterations);
    vaultKey = await unwrap(kek, m.wrapped); // throws if wrong password
    return true;
  } catch { return false; }
}

// Re-wrap the (already-unlocked) DEK under a new password. Recovery + biometric
// wrappers keep working because the DEK itself is unchanged.
export async function changeMaster(newPassword) {
  if (!vaultKey) throw new Error('Unlock first');
  const salt = randomBytes(16);
  const kek = await pbkdf2KEK(newPassword, salt, PBKDF2_ITERATIONS);
  const wrapped = await wrap(kek, vaultKey);
  await db.put('settings', { key: 'vaultMeta', value: { salt: b64(salt), iterations: PBKDF2_ITERATIONS, wrapped } });
  return true;
}

// --- recovery kit (2-of-3 Shamir) ------------------------------------------
export async function recoveryEnabled() { return !!(await meta('recoveryMeta')); }

// Requires an unlocked vault. Generates a fresh recovery key, wraps the DEK
// under it, and returns 3 shares (strings) of which any 2 recover the vault.
export async function setupRecovery() {
  if (!vaultKey) throw new Error('Unlock first');
  const rk = randomBytes(16);
  const salt = randomBytes(16);
  const kek = await hkdfKEK(rk, salt);
  const wrapped = await wrap(kek, vaultKey);
  await db.put('settings', { key: 'recoveryMeta', value: { salt: b64(salt), wrapped } });
  return split(rk, 3, 2).map(encodeShare);
}

// shareStrings: array of >=2 share strings. On success the DEK is unlocked;
// the caller should then set a new master password via changeMaster().
export async function recoverWithShares(shareStrings) {
  const m = await meta('recoveryMeta');
  if (!m) return false;
  try {
    const rk = combine(shareStrings.map(decodeShare));
    const kek = await hkdfKEK(rk, unb64(m.salt));
    vaultKey = await unwrap(kek, m.wrapped);
    return true;
  } catch { return false; }
}

// --- biometric (WebAuthn PRF) ----------------------------------------------
export async function biometricAvailable() {
  try {
    return !!(window.PublicKeyCredential) &&
      await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch { return false; }
}
export async function biometricEnabled() { return !!(await meta('bioMeta')); }

async function prfSecret(credId, salt) {
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: randomBytes(32),
      allowCredentials: [{ type: 'public-key', id: credId }],
      userVerification: 'required', timeout: 60000,
      extensions: { prf: { eval: { first: salt } } },
    },
  });
  const res = assertion.getClientExtensionResults();
  if (res.prf && res.prf.results && res.prf.results.first) return new Uint8Array(res.prf.results.first);
  return null;
}

export async function enableBiometric() {
  if (!vaultKey) throw new Error('Unlock first');
  const prfSalt = randomBytes(32);
  const cred = await navigator.credentials.create({
    publicKey: {
      challenge: randomBytes(32),
      rp: { name: 'Sanctum', id: location.hostname },
      user: { id: randomBytes(16), name: 'batvault-owner', displayName: 'Sanctum' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
      timeout: 60000, extensions: { prf: {} },
    },
  });
  const credId = new Uint8Array(cred.rawId);
  const secret = await prfSecret(credId, prfSalt);
  if (!secret) throw new Error('This device/browser does not support biometric key unlock (WebAuthn PRF).');
  const kek = await rawKEK(secret);
  const wrapped = await wrap(kek, vaultKey);
  await db.put('settings', { key: 'bioMeta', value: { credId: b64(credId), prfSalt: b64(prfSalt), wrapped } });
  return true;
}

export async function disableBiometric() { await db.del('settings', 'bioMeta'); }

export async function unlockBiometric() {
  const m = await meta('bioMeta');
  if (!m) return false;
  const secret = await prfSecret(unb64(m.credId), unb64(m.prfSalt));
  if (!secret) return false;
  const kek = await rawKEK(secret);
  vaultKey = await unwrap(kek, m.wrapped);
  return true;
}
