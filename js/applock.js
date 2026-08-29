// applock.js — biometric gate for opening the app.
//
// This is a SCREEN LOCK, not encryption: it verifies you with the device's
// Face/fingerprint (WebAuthn, userVerification required) before revealing the
// hub. Module-level vaults (Keyring, Strongbox) keep their own separate
// encryption — this does not replace them.
import { db } from './db.js';

const KEY = 'appLockCred';

function rb(n) { return crypto.getRandomValues(new Uint8Array(n)); }
function b64(buf) { return btoa(String.fromCharCode(...new Uint8Array(buf))); }
function unb64(s) { return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); }

export async function available() {
  try {
    return !!window.PublicKeyCredential &&
      await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch { return false; }
}

export async function isEnabled() {
  const r = await db.get('settings', KEY);
  return !!(r && r.value);
}

export async function enable() {
  if (!(await available())) throw new Error('This device has no fingerprint or face unlock available.');
  const cred = await navigator.credentials.create({
    publicKey: {
      challenge: rb(32),
      rp: { name: 'Sanctum', id: location.hostname },
      user: { id: rb(16), name: 'sanctum-owner', displayName: 'Sanctum' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        userVerification: 'required',
        residentKey: 'preferred',
      },
      timeout: 60000,
    },
  });
  if (!cred) throw new Error('Setup cancelled.');
  await db.put('settings', { key: KEY, value: { credId: b64(cred.rawId), at: Date.now() } });
  return true;
}

export async function disable() { await db.del('settings', KEY); }

// Returns true only if the device verified the user.
export async function verify() {
  const r = await db.get('settings', KEY);
  if (!r || !r.value) return true; // not enabled -> nothing to check
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: rb(32),
      allowCredentials: [{ type: 'public-key', id: unb64(r.value.credId) }],
      userVerification: 'required',
      timeout: 60000,
    },
  });
  return !!assertion;
}
