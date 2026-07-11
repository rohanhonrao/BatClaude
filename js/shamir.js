// shamir.js — Shamir's Secret Sharing over GF(256). Splits a secret into `n`
// shares of which any `k` reconstruct it. Used for the 2-of-3 recovery kit.
// No dependencies; GF(256) uses the AES field (primitive poly 0x11b).

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function buildTables() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    // x = x * 3 in GF(256)
    let a = x, b = 3, p = 0;
    while (b) { if (b & 1) p ^= a; const hi = a & 0x80; a = (a << 1) & 0xff; if (hi) a ^= 0x1b; b >>= 1; }
    x = p;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function gmul(a, b) { return (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]]; }
function ginv(a) { return EXP[255 - LOG[a]]; }
function randByte() { return crypto.getRandomValues(new Uint8Array(1))[0]; }

// secret: Uint8Array. Returns [{x, y:Uint8Array}] of length n.
export function split(secret, n = 3, k = 2) {
  const shares = [];
  for (let i = 1; i <= n; i++) shares.push({ x: i, y: new Uint8Array(secret.length) });
  for (let b = 0; b < secret.length; b++) {
    const coeffs = [secret[b]];
    for (let j = 1; j < k; j++) coeffs.push(randByte());
    for (const sh of shares) {
      let acc = 0, xp = 1;
      for (let j = 0; j < k; j++) { acc ^= gmul(coeffs[j], xp); xp = gmul(xp, sh.x); }
      sh.y[b] = acc;
    }
  }
  return shares;
}

// shares: [{x, y:Uint8Array}] (>= k of them). Returns Uint8Array secret.
export function combine(shares) {
  const len = shares[0].y.length;
  const out = new Uint8Array(len);
  for (let b = 0; b < len; b++) {
    let secret = 0;
    for (let i = 0; i < shares.length; i++) {
      let num = 1, den = 1;
      for (let j = 0; j < shares.length; j++) {
        if (i === j) continue;
        num = gmul(num, shares[j].x);
        den = gmul(den, shares[i].x ^ shares[j].x);
      }
      secret ^= gmul(shares[i].y[b], gmul(num, ginv(den)));
    }
    out[b] = secret;
  }
  return out;
}

// --- encoding: "<x>-<hex>" with a group format for readability -------------
function toHex(u8) { return [...u8].map((b) => b.toString(16).padStart(2, '0')).join(''); }
function fromHex(s) { const u = new Uint8Array(s.length / 2); for (let i = 0; i < u.length; i++) u[i] = parseInt(s.substr(i * 2, 2), 16); return u; }

export function encodeShare(sh) {
  const hex = toHex(sh.y).toUpperCase();
  const grouped = hex.match(/.{1,4}/g).join('-');
  return `${sh.x}:${grouped}`;
}
export function decodeShare(str) {
  const clean = str.trim().replace(/\s+/g, '');
  const [x, rest] = clean.split(':');
  if (!rest) throw new Error('Bad share format');
  const hex = rest.replace(/-/g, '');
  return { x: parseInt(x, 10), y: fromHex(hex) };
}
