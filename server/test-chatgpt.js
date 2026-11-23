import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { newPkce, authorizeUrl, parseCallback, decodeJwt, sseParser, extractJson, REDIRECT_URI, SCOPE } from './chatgpt.js';

// PKCE: S256 of the verifier, base64url, no padding
const { verifier, challenge } = newPkce();
assert.equal(challenge, crypto.createHash('sha256').update(verifier).digest('base64url'));
assert.ok(!challenge.includes('='));

// First registration uses dynamic_agent_client + agent_name_hint; reauth uses the issued id and no hint
const first = new URL(authorizeUrl({ clientId: null, hostId: 'urn:uuid:1', challenge: 'c', state: 's', nonce: 'n' }));
assert.equal(first.origin + first.pathname, 'https://auth.openai.com/api/accounts/authorize');
assert.equal(first.searchParams.get('client_id'), 'dynamic_agent_client');
assert.equal(first.searchParams.get('agent_name_hint'), 'LinkPilot');
assert.equal(first.searchParams.get('redirect_uri'), 'http://127.0.0.1:1455/auth/callback');
assert.equal(first.searchParams.get('scope'), SCOPE);
assert.equal(first.searchParams.get('resource'), 'https://api.openai.com/v1');
assert.equal(first.searchParams.get('code_challenge_method'), 'S256');
assert.equal(first.searchParams.get('ext_agent_host_id'), 'urn:uuid:1');
const again = new URL(authorizeUrl({ clientId: 'oaiapp_x', hostId: 'urn:uuid:1', challenge: 'c', state: 's', nonce: 'n' }));
assert.equal(again.searchParams.get('client_id'), 'oaiapp_x');
assert.equal(again.searchParams.get('agent_name_hint'), null);

// Pasted callback address
const cb = parseCallback(`${REDIRECT_URI}?code=abc&state=xyz&client_id=oaiapp_1&scope=openid`);
assert.deepEqual([cb.code, cb.state, cb.clientId], ['abc', 'xyz', 'oaiapp_1']);
assert.equal(parseCallback('http://localhost:1455/auth/callback?code=a').error, 'bad_url');
assert.equal(parseCallback('not a url').error, 'bad_url');
assert.equal(parseCallback(`${REDIRECT_URI}?error=access_denied`).error, 'access_denied');

// JWT claims
const jwt = ['x', Buffer.from(JSON.stringify({ email: 'a@b.c', nonce: 'n' })).toString('base64url'), 'sig'].join('.');
assert.equal(decodeJwt(jwt).email, 'a@b.c');
assert.equal(decodeJwt('garbage'), null);

// Streaming: deltas split across chunks, success only on response.completed
const p = sseParser();
p.feed('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"{\\"mess');
p.feed('age\\": \\"hi\\"}"}\n\ndata: {"type":"response.completed"}\n');
assert.equal(p.done, true);
assert.deepEqual(extractJson(p.text), { message: 'hi' });
const bad = sseParser();
assert.throws(() => bad.feed('data: {"type":"response.failed","response":{"error":{"code":"subscription_sharing_usage_limit_exceeded","message":"limit"}}}\n'),
  (e) => e.code === 'subscription_sharing_usage_limit_exceeded');
assert.deepEqual(extractJson('Sure! {"queries":["a"]} done'), { queries: ['a'] });
assert.throws(() => extractJson('no json here'));

console.log('chatgpt tests passed');

// Responses input must be a list of message items on this route
import { toInputItems } from './chatgpt.js';
assert.deepEqual(toInputItems('hi'), [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }]);
console.log('input format test passed');
