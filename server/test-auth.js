import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, parseUsers, checkLogin, passwordVersion, signSession, verifySession, newDeviceToken, hashToken, rateLimiter } from './auth.js';

const h = hashPassword('correct horse battery');
assert.ok(h.startsWith('scrypt$16384$8$1$'));
assert.equal(verifyPassword('correct horse battery', h), true);
assert.equal(verifyPassword('wrong', h), false);
assert.equal(verifyPassword('x', 'garbage'), false);
assert.notEqual(hashPassword('same'), hashPassword('same')); // salted

const users = parseUsers(`Alice:${h}; bob:notahash ;:x`);
assert.equal(users.size, 1);
assert.equal(checkLogin(users, ' ALICE ', 'correct horse battery'), 'alice'); // usernames are case-insensitive
assert.equal(checkLogin(users, 'alice', 'nope'), null);
assert.equal(checkLogin(users, 'nobody', 'correct horse battery'), null);

const secret = 'x'.repeat(40);
const v = passwordVersion(h);
const tok = signSession({ user: 'alice', version: v }, secret, 1000, 0);
assert.deepEqual(verifySession(tok, secret, 500), { u: 'alice', v, exp: 1000 });
assert.equal(verifySession(tok, secret, 1001), null);            // expired
assert.equal(verifySession(tok, 'y'.repeat(40), 500), null);     // wrong secret
assert.equal(verifySession(tok.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')), secret, 500), null); // tampered
assert.notEqual(passwordVersion(hashPassword('other')), v);       // new password -> old sessions invalid

const dt = newDeviceToken();
assert.ok(dt.length >= 40);
assert.equal(hashToken(dt), hashToken(dt));
assert.notEqual(hashToken(dt), hashToken(newDeviceToken()));

const rl = rateLimiter({ max: 2, windowMs: 100 });
rl.fail('ip', 0); assert.equal(rl.blocked('ip', 1), false);
rl.fail('ip', 2); assert.equal(rl.blocked('ip', 3), true);
assert.equal(rl.blocked('ip', 200), false); // window passed

console.log('auth tests passed');
