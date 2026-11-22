// Username/password login for the dashboard and extensions. No Google, no allowlist.
// Users come from the LINKPILOT_USERS env var: "name:scrypt$...;name2:scrypt$..."
// (make a hash with: node tools/hash-password.js). Passwords are never stored.
import crypto from 'node:crypto';

const N = 16384, R = 8, P = 1, KEYLEN = 32;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(password), salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, salt, key] = parts;
  const want = Buffer.from(key, 'base64url');
  let got;
  try {
    got = crypto.scryptSync(String(password), Buffer.from(salt, 'base64url'), want.length, { N: Number(n), r: Number(r), p: Number(p) });
  } catch { return false; }
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

export function parseUsers(env) {
  const users = new Map();
  for (const entry of String(env || '').split(';')) {
    const i = entry.indexOf(':');
    if (i < 1) continue;
    const name = entry.slice(0, i).trim().toLowerCase();
    const hash = entry.slice(i + 1).trim();
    if (name && hash.startsWith('scrypt$')) users.set(name, hash);
  }
  return users;
}

// Runs scrypt even for unknown users so timing doesn't reveal which usernames exist.
const DUMMY = hashPassword(crypto.randomBytes(8).toString('hex'));
export function checkLogin(users, username, password) {
  const name = String(username || '').trim().toLowerCase();
  const stored = users.get(name);
  const ok = verifyPassword(password, stored || DUMMY);
  return ok && stored ? name : null;
}

// Fingerprint of the stored hash: changing a password logs out that user's old sessions.
export const passwordVersion = (stored) => crypto.createHash('sha256').update(String(stored)).digest('base64url').slice(0, 10);

export function signSession({ user, version }, secret, ttlMs = 30 * 86400000, now = Date.now()) {
  const body = Buffer.from(JSON.stringify({ u: user, v: version, exp: now + ttlMs })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifySession(token, secret, now = Date.now()) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const want = crypto.createHmac('sha256', secret).update(body).digest();
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return p.exp > now ? p : null;
  } catch { return null; }
}

export const newDeviceToken = () => crypto.randomBytes(32).toString('base64url');
export const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

// Simple in-memory brute-force guard (the API runs as a single instance).
export function rateLimiter({ max = 10, windowMs = 15 * 60000 } = {}) {
  const hits = new Map();
  return {
    blocked(key, now = Date.now()) {
      const h = hits.get(key);
      if (!h || now - h.start > windowMs) return false;
      return h.count >= max;
    },
    fail(key, now = Date.now()) {
      const h = hits.get(key);
      if (!h || now - h.start > windowMs) hits.set(key, { start: now, count: 1 });
      else h.count++;
    },
    reset(key) { hits.delete(key); },
  };
}
