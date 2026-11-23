// "Sign in with ChatGPT" (open-source, self-hosted flow): OAuth + PKCE, then the Responses API
// on the user's own ChatGPT plan. Docs: https://developers.openai.com/siwc/token-sharing-open-source
import crypto from 'node:crypto';

export const AUTH_BASE = 'https://auth.openai.com/api/accounts';
export const RESOURCE = 'https://api.openai.com/v1';
export const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
export const REDIRECT_URI = 'http://127.0.0.1:1455/auth/callback'; // must be 127.0.0.1, never localhost
export const APP_NAME = 'LinkPilot';

// Refresh failures that mean "sign in again".
export const REAUTH_ERRORS = new Set([
  'invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired',
  'refresh_token_invalidated', 'refresh_token_reused', 'subscription_sharing_invalid_user',
]);
export const USAGE_LIMIT = 'subscription_sharing_usage_limit_exceeded';

const b64url = (buf) => Buffer.from(buf).toString('base64url');
export const randomToken = (n = 32) => b64url(crypto.randomBytes(n));

export function newPkce() {
  const verifier = randomToken(48);
  return { verifier, challenge: b64url(crypto.createHash('sha256').update(verifier).digest()) };
}

export function authorizeUrl({ clientId, hostId, challenge, state, nonce, email }) {
  const u = new URL(`${AUTH_BASE}/authorize`);
  const p = {
    client_id: clientId || 'dynamic_agent_client',
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    resource: RESOURCE,
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ext_agent_host_id: hostId,
  };
  if (!clientId) p.agent_name_hint = APP_NAME; // first registration only
  if (email) p.login_hint = email;
  for (const [k, v] of Object.entries(p)) u.searchParams.set(k, v);
  return u.toString();
}

// The user pastes the address of the "127.0.0.1 refused to connect" page.
export function parseCallback(pasted) {
  let u;
  try { u = new URL(String(pasted || '').trim()); } catch { return { error: 'bad_url' }; }
  if (u.hostname !== '127.0.0.1' || u.pathname !== '/auth/callback') return { error: 'bad_url' };
  const q = (k) => u.searchParams.get(k);
  return { code: q('code'), state: q('state'), clientId: q('client_id'), scope: q('scope'), error: q('error'), errorDescription: q('error_description') };
}

// The ID token comes straight from the token endpoint over TLS, so reading its claims is enough here (OIDC 3.1.3.7).
export function decodeJwt(t) {
  try { return JSON.parse(Buffer.from(String(t).split('.')[1], 'base64url').toString('utf8')); } catch { return null; }
}

async function postForm(url, fields) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(fields),
    signal: AbortSignal.timeout(30000),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(d.error_description || d.error?.message || d.error || d.detail || `HTTP ${r.status}`);
    e.code = d.error?.code || (typeof d.error === 'string' ? d.error : String(r.status));
    throw e;
  }
  return d;
}

export const exchangeCode = ({ clientId, code, verifier }) => postForm(`${AUTH_BASE}/oauth/token`, {
  grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: REDIRECT_URI, resource: RESOURCE,
});

export const refreshTokens = ({ clientId, refreshToken }) => postForm(`${AUTH_BASE}/oauth/token`, {
  grant_type: 'refresh_token', client_id: clientId, refresh_token: refreshToken, resource: RESOURCE,
});

export async function revoke({ clientId, refreshToken }) {
  try {
    const disc = await fetch('https://auth.openai.com/.well-known/openid-configuration', { signal: AbortSignal.timeout(10000) }).then((r) => r.json());
    if (!disc.revocation_endpoint) return false;
    await postForm(disc.revocation_endpoint, { token: refreshToken, token_type_hint: 'refresh_token', client_id: clientId });
    return true;
  } catch { return false; }
}

async function apiError(r) {
  const d = await r.json().catch(() => ({}));
  const e = new Error(d.error?.message || d.detail || `HTTP ${r.status}`);
  e.code = d.error?.code || String(r.status);
  e.status = r.status;
  return e;
}

export async function listModels(accessToken) {
  const r = await fetch(`${RESOURCE}/models`, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw await apiError(r);
  const d = await r.json();
  return (d.data || d.models || []).filter((m) => !m.visibility || m.visibility === 'list').map((m) => m.slug || m.id).filter(Boolean);
}

// Server-sent events from /v1/responses. Feed text chunks; read .text once .done.
export function sseParser() {
  let buf = '';
  const out = { text: '', done: false, feed };
  function feed(chunk) {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let ev;
      try { ev = JSON.parse(data); } catch { continue; }
      if (ev.type === 'response.output_text.delta') out.text += ev.delta || '';
      else if (ev.type === 'response.completed') out.done = true;
      else if (ev.type === 'response.failed' || ev.type === 'error') {
        const err = ev.response?.error || ev.error || ev;
        const e = new Error(err.message || 'ChatGPT request failed');
        e.code = err.code || 'response_failed';
        throw e;
      } else if (ev.type === 'response.incomplete') {
        const e = new Error('ChatGPT stopped early');
        e.code = ev.response?.incomplete_details?.reason || 'incomplete';
        throw e;
      }
    }
  }
  return out;
}

// This route only accepts input as a list of message items (a plain string is rejected: "Input must be a list").
export const toInputItems = (text) => [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: String(text ?? '') }] }];

export async function respond({ accessToken, model, instructions, input }) {
  const r = await fetch(`${RESOURCE}/responses`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ model, instructions, input: Array.isArray(input) ? input : toInputItems(input), store: false, stream: true }),
    signal: AbortSignal.timeout(90000),
  });
  if (!r.ok) throw await apiError(r);
  const p = sseParser();
  const dec = new TextDecoder();
  for await (const chunk of r.body) p.feed(dec.decode(chunk, { stream: true }));
  p.feed('\n');
  if (!p.done) throw Object.assign(new Error('ChatGPT stream ended early'), { code: 'incomplete' });
  return p.text;
}

// Pull the first JSON object out of model text (no JSON mode on this route).
export function extractJson(text) {
  const s = String(text || '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('AI did not return JSON');
  return JSON.parse(s.slice(a, b + 1));
}
