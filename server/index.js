import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import {
  DEFAULT_SETTINGS, cleanSettings, inActiveWindow, lastNDateKeys, zonedParts,
  normalizeProfileUrl, randomGapMs, FINAL_OUTCOMES,
  searchUrl, nextCursor, hashText, isFirstDegree, cleanDm, planMessages, filterMessages, dmMessages,
} from './lib.js';
import * as gpt from './chatgpt.js';

initializeApp();
const db = getFirestore();
const auth = getAuth();

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
const EXT_TOKEN = process.env.EXT_TOKEN || '';
if (!ADMIN_EMAILS.length) console.warn('ADMIN_EMAILS is empty: nobody can use the dashboard');
if (EXT_TOKEN.length < 24) console.warn('EXT_TOKEN missing or too short: extension calls will be rejected');

const leads = db.collection('leads');
const settingsRef = db.doc('meta/settings');
const stateRef = db.doc('meta/state');
const aiKeyRef = db.doc('private/openai'); // Firestore rules deny all client access; only this API reads it
const chatgptRef = db.doc('private/chatgpt'); // Sign in with ChatGPT tokens
const loginRef = db.doc('private/chatgpt_login'); // pending PKCE login
const dailyRef = (key) => db.doc(`daily/${key}`);

const STALE_MS = 15 * 60000;
const LOCK_MS = 10 * 60000;
const ACCEPT_CHECK_EVERY = 3 * 3600000;
const CONNECTIONS_URL = 'https://www.linkedin.com/mynetwork/invite-connect/connections/';
const actionGap = () => Math.round((4 + Math.random() * 4) * 60000); // 4-8 min between non-invite actions
const inc = (n) => FieldValue.increment(n);

const app = express();
app.use(cors({ origin: (o, cb) => cb(null, !o || o.startsWith('chrome-extension://')), allowedHeaders: ['Content-Type', 'Authorization', 'X-Ext-Token'] }));
app.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.use(express.json({ limit: '2mb' }));

// Express 4 doesn't catch async errors; an unhandled rejection would crash the instance.
for (const m of ['get', 'post', 'put', 'delete']) {
  const orig = app[m].bind(app);
  app[m] = (path, ...hs) => orig(path, ...hs.map((h) => (req, res, next) => {
    try { const r = h(req, res, next); if (r && typeof r.catch === 'function') r.catch(next); } catch (e) { next(e); }
  }));
}

const validId = (id) => typeof id === 'string' && id.length > 0 && id.length < 700 && !id.includes('/') && id !== '.' && id !== '..';

// ---------- auth ----------
async function adminAuth(req, res, next) {
  try {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ error: 'not signed in' });
    const user = await auth.verifyIdToken(token);
    if (!user.email || user.email_verified === false || !ADMIN_EMAILS.includes(user.email.toLowerCase())) {
      return res.status(403).json({ error: `${user.email || 'this account'} is not allowed` });
    }
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: 'bad or expired sign-in' });
  }
}

function extAuth(req, res, next) {
  const t = Buffer.from(String(req.headers['x-ext-token'] || ''));
  const k = Buffer.from(EXT_TOKEN);
  if (k.length < 24 || t.length !== k.length || !crypto.timingSafeEqual(t, k)) return res.status(401).json({ error: 'bad extension token' });
  next();
}

// ---------- helpers ----------
async function getSettings() {
  const snap = await settingsRef.get();
  return { ...DEFAULT_SETTINGS, ...(snap.data() || {}) };
}

async function getAiKey() {
  return (await aiKeyRef.get()).data()?.key || '';
}

// ---------- ChatGPT plan (preferred) ----------
let refreshing = null; // one refresh at a time (the service runs with max 1 instance)

async function chatgptAccess() {
  const c = (await chatgptRef.get()).data();
  if (!c?.refreshToken) return null;
  if ((c.accessExpiresAt || 0) > Date.now() + 120000 && c.accessToken) return { token: c.accessToken, model: c.model };
  if (!refreshing) {
    refreshing = (async () => {
      try {
        const t = await gpt.refreshTokens({ clientId: c.clientId, refreshToken: c.refreshToken });
        await chatgptRef.set({
          accessToken: t.access_token, refreshToken: t.refresh_token || c.refreshToken,
          accessExpiresAt: Date.now() + (Number(t.expires_in) || 3600) * 1000, needsSignIn: false,
        }, { merge: true });
        return t.access_token;
      } catch (e) {
        if (gpt.REAUTH_ERRORS.has(e.code)) {
          await chatgptRef.set({ accessToken: null, refreshToken: null, needsSignIn: true }, { merge: true });
          throw new Error('ChatGPT sign-in expired. Sign in again in the dashboard.');
        }
        throw e;
      } finally { refreshing = null; }
    })();
  }
  return { token: await refreshing, model: c.model };
}

async function aiReady() {
  const [c, key, st] = await Promise.all([chatgptRef.get(), getAiKey(), stateRef.get()]);
  if ((st.data()?.aiPausedUntil || 0) > Date.now()) return false;
  return !!(c.data()?.refreshToken || key);
}

async function ai(s, messages) {
  const g = await chatgptAccess();
  if (g) {
    const instructions = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n') +
      '\n\nReply with the JSON object only, no other text.';
    const input = messages.filter((m) => m.role !== 'system').map((m) => m.content).join('\n\n');
    try {
      return gpt.extractJson(await gpt.respond({ accessToken: g.token, model: g.model || s.aiModel, instructions, input }));
    } catch (e) {
      if (e.code === gpt.USAGE_LIMIT) {
        await stateRef.set({ aiPausedUntil: Date.now() + 3600000, lastError: 'ChatGPT plan usage limit reached. AI paused for 1 hour (see chatgpt.com/settings/usage).' }, { merge: true });
      } else if (gpt.REAUTH_ERRORS.has(e.code)) {
        await chatgptRef.set({ accessToken: null, refreshToken: null, needsSignIn: true }, { merge: true });
      }
      throw new Error(`ChatGPT: ${e.message}`);
    }
  }
  const key = await getAiKey();
  if (!key) throw new Error('AI not connected. Sign in with ChatGPT in the dashboard.');
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: s.aiModel, messages, response_format: { type: 'json_object' }, temperature: 0.7 }),
    signal: AbortSignal.timeout(60000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`OpenAI: ${data.error?.message || `HTTP ${r.status}`}`);
  try { return JSON.parse(data.choices?.[0]?.message?.content || '{}'); } catch { throw new Error('OpenAI returned bad JSON'); }
}

async function counts(s, now, tx) {
  const keys = lastNDateKeys(now, s.timezone, 7);
  const refs = keys.map(dailyRef);
  const snaps = tx ? await tx.getAll(...refs) : await db.getAll(...refs);
  const today = zonedParts(new Date(now), s.timezone).dateKey;
  let week = 0, t = {};
  for (const sn of snaps) {
    week += sn.data()?.sent || 0;
    if (sn.id === today) t = sn.data() || {};
  }
  return { today: t.sent || 0, week, dmsToday: t.dms || 0, searchesToday: t.searches || 0, todayKey: today };
}

async function bumpDaily(s, field, now = Date.now()) {
  const key = zonedParts(new Date(now), s.timezone).dateKey;
  await dailyRef(key).set({ [field]: inc(1) }, { merge: true });
}

async function releaseStale(now) {
  const snap = await leads.where('status', 'in', ['in_progress', 'dm_in_progress']).get();
  const batch = db.batch();
  let n = 0;
  for (const d of snap.docs) {
    if ((d.data().claimedAt || 0) < now - STALE_MS) {
      // A DM retry is safe: the sender checks the chat history first and skips if anything is there.
      batch.update(d.ref, { status: d.data().status === 'dm_in_progress' ? 'accepted' : 'queued', claimedAt: null });
      n++;
    }
  }
  if (n) await batch.commit();
}

async function finishAction(extra = {}) {
  await stateRef.set({ lock: null, nextActionAt: Date.now() + actionGap(), ...extra }, { merge: true });
}

async function ensurePlan(s, st, force = false) {
  const hash = hashText(s.campaignPrompt);
  if (!force && st.searchPlan?.hash === hash && st.searchPlan.queries?.length) return st.searchPlan;
  const out = await ai(s, planMessages(s));
  const queries = (Array.isArray(out.queries) ? out.queries : [])
    .map((q) => String(q).replace(/\s+/g, ' ').trim().slice(0, 80)).filter(Boolean).slice(0, 8);
  if (!queries.length) throw new Error('AI returned no search queries');
  const plan = { hash, queries, summary: String(out.summary || '').slice(0, 300), at: Date.now() };
  await stateRef.set({ searchPlan: plan, searchCursor: { q: 0, p: 1 }, searchExhausted: false }, { merge: true });
  return plan;
}

async function writeDm(s, lead) {
  for (let i = 0; i < 2; i++) {
    const out = await ai(s, dmMessages(s, lead));
    const msg = cleanDm(out.message);
    if (msg) return msg;
  }
  throw new Error('AI message failed the checks twice (too long, link or placeholder)');
}

// ---------- extension endpoints ----------
app.post('/api/ext/ping', extAuth, async (req, res) => {
  const now = Date.now();
  await stateRef.set({ lastSeen: now, extVersion: req.body?.version || null }, { merge: true });
  const s = await getSettings();
  const queued = (await leads.where('status', '==', 'queued').count().get()).data().count;
  res.json({ ok: true, paused: s.paused, queued, activeNow: inActiveWindow(now, s), aiReady: await aiReady() });
});

// Read-only summary for the extension popup.
app.post('/api/ext/status', extAuth, async (req, res) => {
  const now = Date.now();
  const s = await getSettings();
  const cnt = (st) => leads.where('status', '==', st).count().get().then((x) => x.data().count);
  const [c, st, queued, accepted, key] = await Promise.all([
    counts(s, now), stateRef.get().then((x) => x.data() || {}), cnt('queued'), cnt('accepted'), aiReady(),
  ]);
  const lr = st.lastResult;
  res.json({
    paused: s.paused, activeNow: inActiveWindow(now, s), pausedUntil: (st.pausedUntil || 0) > now ? st.pausedUntil : null,
    window: `${s.activeStart}–${s.activeEnd}`, today: c.today, dailyLimit: s.dailyLimit, week: c.week, weeklyLimit: s.weeklyLimit,
    dmsToday: c.dmsToday, dmDailyLimit: s.dmDailyLimit, queued, accepted, aiReady: !!key, hasCampaign: !!s.campaignPrompt.trim(),
    nextInviteAt: (st.nextAllowedAt || 0) > now ? st.nextAllowedAt : null, lastWait: st.lastWait || null, lastError: st.lastError || null,
    lastResult: lr ? { name: lr.name || '', outcome: lr.outcome, at: lr.at } : null,
  });
});

// Start/Pause from the popup (same switch as the dashboard's Start/Pause).
app.post('/api/ext/pause', extAuth, async (req, res) => {
  const paused = req.body?.paused === true;
  const s = cleanSettings({ ...(await getSettings()), paused });
  await settingsRef.set(s);
  if (!paused) await stateRef.set({ pausedUntil: 0, lastError: null }, { merge: true });
  res.json({ paused });
});

// Hands the extension its next job: connect > DM > accept check > search.
app.post('/api/ext/claim', extAuth, async (req, res) => {
  const now = Date.now();
  await stateRef.set({ lastSeen: now, extVersion: req.body?.version || null }, { merge: true });
  await releaseStale(now);
  const hasKey = await aiReady();

  const out = await db.runTransaction(async (tx) => {
    const [sSnap, stSnap] = await tx.getAll(settingsRef, stateRef);
    const s = { ...DEFAULT_SETTINGS, ...(sSnap.data() || {}) };
    const st = stSnap.data() || {};
    if (s.paused) return { wait: 'paused' };
    if ((st.pausedUntil || 0) > now) return { wait: `auto-paused until ${new Date(st.pausedUntil).toISOString()}` };
    if (!inActiveWindow(now, s)) return { wait: 'outside active hours' };
    if ((st.lock?.until || 0) > now) return { wait: `busy (${st.lock.type})` };
    const busy = await tx.get(leads.where('status', 'in', ['in_progress', 'dm_in_progress']).limit(1));
    if (!busy.empty) return { wait: 'another task is in progress' };

    const c = await counts(s, now, tx);
    const reasons = [];

    // 1. Connection request (keeps its own even spacing)
    if (c.today >= s.dailyLimit) reasons.push(`daily limit hit (${c.today}/${s.dailyLimit})`);
    else if (c.week >= s.weeklyLimit) reasons.push(`weekly limit hit (${c.week}/${s.weeklyLimit})`);
    else if ((st.nextAllowedAt || 0) > now) reasons.push(`next invite after ${new Date(st.nextAllowedAt).toISOString()}`);
    else {
      const q = await tx.get(leads.where('status', '==', 'queued').orderBy('createdAt').limit(1));
      if (!q.empty) {
        const d = q.docs[0];
        tx.update(d.ref, { status: 'in_progress', claimedAt: now, attempts: inc(1) });
        const lead = { id: d.id, url: d.data().url, name: d.data().name || '' };
        return { task: { type: 'connect', lead }, lead };
      }
      reasons.push('queue empty');
    }

    const actionOk = (st.nextActionAt || 0) <= now;

    // 2. Follow-up DM to someone who accepted
    if (actionOk && s.dmEnabled && hasKey && c.dmsToday < s.dmDailyLimit) {
      const a = await tx.get(leads.where('status', '==', 'accepted').limit(1));
      if (!a.empty) {
        const d = a.docs[0];
        tx.update(d.ref, { status: 'dm_in_progress', claimedAt: now, dmAttempts: inc(1) });
        tx.set(stateRef, { lock: { type: 'dm', until: now + LOCK_MS } }, { merge: true });
        return { dmLeadId: d.id };
      }
    }

    // 3. Check who accepted (every 3 hours, only if someone is pending)
    if (actionOk && s.dmEnabled && now - (st.lastAcceptCheckAt || 0) > ACCEPT_CHECK_EVERY) {
      const sent = await tx.get(leads.where('status', '==', 'sent').limit(1));
      if (!sent.empty) {
        tx.set(stateRef, { lock: { type: 'accept_check', until: now + LOCK_MS }, lastAcceptCheckAt: now }, { merge: true });
        return { task: { type: 'accept_check', url: CONNECTIONS_URL } };
      }
    }

    // 4. Find more people from the campaign prompt
    const exhausted = st.searchExhausted && st.searchPlan?.hash === hashText(s.campaignPrompt);
    if (actionOk && s.searchEnabled && hasKey && s.campaignPrompt.trim() && !exhausted && c.searchesToday < s.searchesPerDay) {
      const queued = (await tx.get(leads.where('status', '==', 'queued').limit(s.searchBuffer))).size;
      if (queued < s.searchBuffer) {
        tx.set(stateRef, { lock: { type: 'search', until: now + LOCK_MS } }, { merge: true });
        return { needSearch: true };
      }
    }
    if (exhausted) reasons.push('search used up for this prompt (change the prompt to find more)');
    return { wait: reasons[0] || 'nothing to do' };
  });

  if (out.dmLeadId) {
    const ref = leads.doc(out.dmLeadId);
    const lead = (await ref.get()).data();
    let message = lead.dmText;
    if (!message) {
      try {
        message = await writeDm(await getSettings(), lead);
        await ref.update({ dmText: message });
      } catch (e) {
        const failed = (lead.dmAttempts || 0) >= 3;
        await ref.update({ status: failed ? 'dm_failed' : 'accepted', claimedAt: null, detail: String(e.message).slice(0, 300) });
        await finishAction({ lastError: `Could not write a message: ${e.message}` });
        return res.json({ wait: 'AI message failed' });
      }
    }
    return res.json({ task: { type: 'dm', lead: { id: out.dmLeadId, url: lead.url, name: lead.name || '' }, message } });
  }

  if (out.needSearch) {
    try {
      const s = await getSettings();
      const st = (await stateRef.get()).data() || {};
      const plan = await ensurePlan(s, st);
      const cur = (await stateRef.get()).data()?.searchCursor || { q: 0, p: 1 };
      if (cur.q >= plan.queries.length) {
        await finishAction({ searchExhausted: true });
        return res.json({ wait: 'search used up for this prompt' });
      }
      return res.json({ task: { type: 'search', url: searchUrl(plan.queries[cur.q], cur.p), key: `${plan.hash}:${cur.q}:${cur.p}` } });
    } catch (e) {
      await finishAction({ lastError: `Search planning failed: ${e.message}` });
      return res.json({ wait: 'search planning failed' });
    }
  }

  if (out.wait) await stateRef.set({ lastWait: out.wait }, { merge: true });
  res.json(out.task ? { task: out.task, lead: out.lead } : { wait: out.wait });
});

// Result of a connection request.
app.post('/api/ext/result', extAuth, async (req, res) => {
  const { id, outcome, detail, profile, finalUrl } = req.body || {};
  if (!validId(id) || !outcome || typeof outcome !== 'string') return res.status(400).json({ error: 'id and outcome required' });
  const now = Date.now();
  const s = await getSettings();
  const ref = leads.doc(String(id));
  const todayKey = zonedParts(new Date(now), s.timezone).dateKey;
  const note = detail ? String(detail).slice(0, 300) : null;
  const extra = {};
  if (typeof profile === 'string' && profile.trim()) extra.profile = profile.slice(0, 5000);
  const canon = normalizeProfileUrl(finalUrl);
  if (canon) extra.canonicalSlug = canon.slug;

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const lead = snap.data();
    // Duplicate/late report for a lead that's already final: don't double count.
    if (lead.status !== 'in_progress' && lead.status !== 'queued') return;
    const log = { at: now, outcome, detail: note };
    const st = { lastResult: { ...log, leadId: id, name: lead.name || '' } };

    if (outcome === 'sent') {
      tx.update(ref, { ...extra, status: 'sent', sentAt: now, detail: note, claimedAt: null, history: FieldValue.arrayUnion(log) });
      tx.set(dailyRef(todayKey), { sent: inc(1) }, { merge: true });
      st.nextAllowedAt = now + randomGapMs(s);
      st.lastError = null;
    } else if (FINAL_OUTCOMES.has(outcome)) {
      tx.update(ref, { ...extra, status: outcome, detail: note, claimedAt: null, history: FieldValue.arrayUnion(log) });
      st.nextAllowedAt = now + (1 + Math.random() * 2) * 60000; // still a profile visit, small gap
      st.lastError = null;
    } else if (outcome === 'weekly_limit') {
      tx.update(ref, { status: 'queued', claimedAt: null, detail: note, attempts: inc(-1), history: FieldValue.arrayUnion(log) });
      st.pausedUntil = now + 48 * 3600000;
      st.lastError = 'LinkedIn weekly invite limit hit. Auto-paused for 48 hours.';
    } else if (outcome === 'logged_out') {
      tx.update(ref, { status: 'queued', claimedAt: null, attempts: inc(-1), history: FieldValue.arrayUnion(log) });
      st.pausedUntil = now + 30 * 60000;
      st.lastError = 'LinkedIn is logged out in Chrome. Log back in. Retrying in 30 min.';
    } else {
      const failed = (lead.attempts || 0) >= 3;
      tx.update(ref, { status: failed ? 'failed' : 'queued', claimedAt: null, detail: note, history: FieldValue.arrayUnion(log) });
      st.nextAllowedAt = now + (2 + Math.random() * 3) * 60000;
      st.lastError = `Error on ${lead.name || id}: ${note || outcome}`;
    }
    tx.set(stateRef, st, { merge: true });
  });
  res.json({ ok: true });
});

// Result of a follow-up DM.
app.post('/api/ext/dm-result', extAuth, async (req, res) => {
  const { id, outcome, detail } = req.body || {};
  if (!validId(id) || typeof outcome !== 'string') return res.status(400).json({ error: 'id and outcome required' });
  const now = Date.now();
  const s = await getSettings();
  const ref = leads.doc(id);
  const note = detail ? String(detail).slice(0, 300) : null;
  const snap = await ref.get();
  if (!snap.exists || snap.data().status !== 'dm_in_progress') { await finishAction(); return res.json({ ok: true }); }
  const lead = snap.data();
  const log = { at: now, outcome: `dm_${outcome}`, detail: note };
  const st = { lastResult: { ...log, leadId: id, name: lead.name || '' } };

  if (outcome === 'sent') {
    await ref.update({ status: 'messaged', dmSentAt: now, detail: null, claimedAt: null, history: FieldValue.arrayUnion(log) });
    await bumpDaily(s, 'dms', now);
    st.lastError = null;
  } else if (outcome === 'already_messaged' || outcome === 'not_connected' || outcome === 'no_message_button') {
    await ref.update({ status: 'dm_skipped', detail: note || outcome.replace(/_/g, ' '), claimedAt: null, history: FieldValue.arrayUnion(log) });
  } else if (outcome === 'uncertain') {
    // Send was clicked but we couldn't confirm it. Never retry: a double text is worse than a missed one.
    await ref.update({ status: 'dm_failed', detail: note || 'not sure it sent, check the chat', claimedAt: null, history: FieldValue.arrayUnion(log) });
  } else if (outcome === 'logged_out') {
    await ref.update({ status: 'accepted', claimedAt: null, dmAttempts: inc(-1), history: FieldValue.arrayUnion(log) });
    st.pausedUntil = now + 30 * 60000;
    st.lastError = 'LinkedIn is logged out in Chrome. Log back in. Retrying in 30 min.';
  } else {
    const failed = (lead.dmAttempts || 0) >= 3;
    await ref.update({ status: failed ? 'dm_failed' : 'accepted', detail: note, claimedAt: null, history: FieldValue.arrayUnion(log) });
    st.lastError = `DM error on ${lead.name || id}: ${note || outcome}`;
  }
  await finishAction(st);
  res.json({ ok: true });
});

// List of profile links from "recently added" connections.
app.post('/api/ext/accepted', extAuth, async (req, res) => {
  const { hrefs, error } = req.body || {};
  if (error === 'logged_out') {
    await finishAction({ pausedUntil: Date.now() + 30 * 60000, lastError: 'LinkedIn is logged out in Chrome. Log back in. Retrying in 30 min.', lastAcceptCheckAt: 0 });
    return res.json({ ok: true });
  }
  const slugs = new Set((Array.isArray(hrefs) ? hrefs : []).slice(0, 300).map((h) => normalizeProfileUrl(h)?.slug).filter(Boolean));
  let accepted = 0;
  if (slugs.size) {
    const sent = await leads.where('status', '==', 'sent').get();
    const batch = db.batch();
    const now = Date.now();
    for (const d of sent.docs) {
      const slug = decodeURIComponent(d.id);
      if (slugs.has(slug) || (d.data().canonicalSlug && slugs.has(d.data().canonicalSlug))) {
        batch.update(d.ref, { status: 'accepted', acceptedAt: now });
        accepted++;
      }
    }
    if (accepted) await batch.commit();
  }
  await finishAction({ lastAcceptCheck: { at: Date.now(), seen: slugs.size, accepted, error: error || null } });
  res.json({ ok: true, accepted });
});

// People-search page results.
app.post('/api/ext/search-result', extAuth, async (req, res) => {
  const { key, results, error } = req.body || {};
  const s = await getSettings();
  const st = (await stateRef.get()).data() || {};
  const plan = st.searchPlan;
  if (error === 'logged_out') {
    await finishAction({ pausedUntil: Date.now() + 30 * 60000, lastError: 'LinkedIn is logged out in Chrome. Log back in. Retrying in 30 min.' });
    return res.json({ ok: true });
  }
  await bumpDaily(s, 'searches');
  const [hash, qs, ps] = String(key || '').split(':');
  const cur = { q: Number(qs), p: Number(ps) };
  const stale = !plan || hash !== plan.hash;
  const raw = Array.isArray(results) ? results.slice(0, 20) : [];

  // Dedupe against everyone we've ever seen (leads are keyed by profile slug).
  const byId = new Map();
  for (const r of raw) {
    const n = normalizeProfileUrl(r?.url);
    const text = String(r?.text || '').replace(/\s+/g, ' ').trim().slice(0, 600);
    if (!n || !text || isFirstDegree(text) || byId.has(n.id)) continue;
    byId.set(n.id, { ...n, text });
  }
  let fresh = [];
  if (byId.size) {
    const snaps = await db.getAll(...[...byId.keys()].map((id) => leads.doc(id)));
    fresh = snaps.filter((sn) => !sn.exists).map((sn) => byId.get(sn.id));
  }

  let added = 0, skipped = 0;
  if (fresh.length && !stale) {
    let matches;
    try {
      const out = await ai(s, filterMessages(s, fresh));
      matches = new Map((Array.isArray(out.matches) ? out.matches : []).filter((m) => Number.isInteger(m?.i) && fresh[m.i]).map((m) => [m.i, m]));
    } catch (e) {
      await finishAction({ lastError: `AI screening failed: ${e.message}` }); // cursor not advanced: page retried later
      return res.json({ ok: false });
    }
    const now = Date.now();
    const batch = db.batch();
    fresh.forEach((c, i) => {
      const m = matches.get(i);
      batch.set(leads.doc(c.id), {
        url: c.url, name: String(m?.name || '').slice(0, 120), headline: c.text, source: 'search',
        status: m ? 'queued' : 'ai_skipped', matchReason: m ? String(m.reason || '').slice(0, 200) : null,
        createdAt: now + i, attempts: 0,
      });
      if (m) added++; else skipped++;
    });
    await batch.commit();
  }

  const extra = { lastSearch: { at: Date.now(), found: raw.length, added, skipped, error: error || null } };
  if (!stale && Number.isInteger(cur.q)) {
    const next = nextCursor(cur, plan.queries.length, raw.length === 0);
    extra.searchCursor = next || { q: plan.queries.length, p: 1 };
    if (!next) extra.searchExhausted = true;
  }
  await finishAction(extra);
  res.json({ ok: true, added, skipped });
});

// ---------- dashboard endpoints ----------
app.get('/api/me', adminAuth, (req, res) => res.json({ email: req.user.email }));

app.get('/api/stats', adminAuth, async (req, res) => {
  const now = Date.now();
  const s = await getSettings();
  const cnt = (st) => leads.where('status', '==', st).count().get().then((x) => x.data().count);
  const [c, st, queued, accepted, messaged, key] = await Promise.all([
    counts(s, now), stateRef.get().then((x) => x.data() || {}), cnt('queued'), cnt('accepted'), cnt('messaged'), aiReady(),
  ]);
  res.json({
    now, today: c.today, week: c.week, dmsToday: c.dmsToday, searchesToday: c.searchesToday,
    queued, accepted, messaged, aiReady: !!key, settings: s, state: st, activeNow: inActiveWindow(now, s),
  });
});

app.get('/api/settings', adminAuth, async (req, res) => res.json(await getSettings()));

app.put('/api/settings', adminAuth, async (req, res) => {
  const current = await getSettings();
  const s = cleanSettings({ ...current, ...(req.body || {}) });
  await settingsRef.set(s);
  if (req.body?.clearAutoPause) await stateRef.set({ pausedUntil: 0, lastError: null }, { merge: true });
  res.json(s);
});

app.get('/api/ai', adminAuth, async (req, res) => {
  const [key, c] = await Promise.all([getAiKey(), chatgptRef.get().then((x) => x.data() || {})]);
  res.json({
    chatgpt: { connected: !!c.refreshToken, email: c.email || null, model: c.model || null, models: c.models || [], needsSignIn: !!c.needsSignIn },
    apiKey: { connected: !!key, last4: key ? key.slice(-4) : null },
  });
});

// Step 1: build the ChatGPT sign-in link (PKCE). The browser lands on 127.0.0.1 afterwards; the user pastes that address back.
app.post('/api/ai/chatgpt/start', adminAuth, async (req, res) => {
  const c = (await chatgptRef.get()).data() || {};
  const hostId = c.hostId || `urn:uuid:${crypto.randomUUID()}`; // one id per LinkPilot deployment
  if (!c.hostId) await chatgptRef.set({ hostId }, { merge: true });
  const { verifier, challenge } = gpt.newPkce();
  const state = gpt.randomToken(24), nonce = gpt.randomToken(24);
  await loginRef.set({ verifier, state, nonce, at: Date.now(), by: req.user.email });
  res.json({ url: gpt.authorizeUrl({ clientId: c.clientId || null, hostId, challenge, state, nonce, email: req.user.email }) });
});

// Step 2: finish with the pasted 127.0.0.1 address.
app.post('/api/ai/chatgpt/finish', adminAuth, async (req, res) => {
  const cb = gpt.parseCallback(req.body?.callbackUrl);
  if (cb.error === 'bad_url') return res.status(400).json({ error: 'Paste the full address that starts with http://127.0.0.1:1455/auth/callback' });
  if (cb.error) return res.status(400).json({ error: `ChatGPT said: ${cb.errorDescription || cb.error}` });
  const p = (await loginRef.get()).data();
  if (!p || p.state !== cb.state || Date.now() - p.at > 15 * 60000) return res.status(400).json({ error: 'That sign-in link expired or does not match. Click Sign in with ChatGPT again.' });
  const c = (await chatgptRef.get()).data() || {};
  const clientId = cb.clientId || c.clientId;
  if (!clientId || clientId === 'dynamic_agent_client') return res.status(400).json({ error: 'ChatGPT did not finish registering this app. Try signing in again.' });
  await chatgptRef.set({ clientId }, { merge: true }); // keep the issued id even if the exchange fails
  let t;
  try {
    t = await gpt.exchangeCode({ clientId, code: cb.code, verifier: p.verifier });
  } catch (e) {
    await loginRef.delete();
    return res.status(400).json({ error: `Sign-in failed: ${e.message}. Click Sign in with ChatGPT again.` });
  }
  await loginRef.delete();
  if (!String(t.scope || '').split(' ').includes('chatgpt.tokens.use.direct')) {
    return res.status(400).json({ error: 'This ChatGPT account did not grant plan usage (needs an eligible ChatGPT plan).' });
  }
  const claims = gpt.decodeJwt(t.id_token) || {};
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.nonce && claims.nonce !== p.nonce) return res.status(400).json({ error: 'Sign-in check failed (nonce). Try again.' });
  if (claims.aud && !aud.includes(clientId)) return res.status(400).json({ error: 'Sign-in check failed (audience). Try again.' });
  let models = [];
  try { models = await gpt.listModels(t.access_token); } catch { /* keep going; model can be set later */ }
  const s = await getSettings();
  const model = models.includes(c.model) ? c.model : models.includes(s.aiModel) ? s.aiModel : models[0] || null;
  await chatgptRef.set({
    clientId, accessToken: t.access_token, refreshToken: t.refresh_token,
    accessExpiresAt: Date.now() + (Number(t.expires_in) || 3600) * 1000,
    email: claims.email || null, models: models.slice(0, 50), model, needsSignIn: false, connectedAt: Date.now(), connectedBy: req.user.email,
  }, { merge: true });
  await stateRef.set({ aiPausedUntil: 0, lastError: null }, { merge: true });
  res.json({ connected: true, email: claims.email || null, model, models });
});

app.put('/api/ai/chatgpt/model', adminAuth, async (req, res) => {
  const c = (await chatgptRef.get()).data() || {};
  const model = String(req.body?.model || '');
  if (!(c.models || []).includes(model)) return res.status(400).json({ error: 'Pick a model from the list' });
  await chatgptRef.set({ model }, { merge: true });
  res.json({ model });
});

app.delete('/api/ai/chatgpt', adminAuth, async (req, res) => {
  const c = (await chatgptRef.get()).data() || {};
  if (c.refreshToken) await gpt.revoke({ clientId: c.clientId, refreshToken: c.refreshToken });
  // Keep clientId + hostId so the next sign-in reuses the same registration.
  await chatgptRef.set({ accessToken: null, refreshToken: null, email: null, needsSignIn: false }, { merge: true });
  res.json({ connected: false });
});

// The key is checked against OpenAI, stored server-side, and never sent back.
app.put('/api/ai', adminAuth, async (req, res) => {
  const key = String(req.body?.key || '').trim();
  if (!key) { await aiKeyRef.delete(); return res.json({ connected: false }); }
  if (!/^sk-[\w-]{20,}$/.test(key)) return res.status(400).json({ error: 'That does not look like an OpenAI API key (starts with sk-)' });
  const r = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) return res.status(400).json({ error: `OpenAI rejected the key (HTTP ${r.status})` });
  await aiKeyRef.set({ key, setBy: req.user.email, at: Date.now() });
  res.json({ connected: true, last4: key.slice(-4) });
});

app.post('/api/campaign/plan', adminAuth, async (req, res) => {
  const s = await getSettings();
  if (!s.campaignPrompt.trim()) return res.status(400).json({ error: 'Write a campaign prompt first' });
  try {
    res.json(await ensurePlan(s, (await stateRef.get()).data() || {}, true));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/ai/preview-dm', adminAuth, async (req, res) => {
  const s = await getSettings();
  let lead;
  if (validId(req.body?.leadId)) lead = (await leads.doc(req.body.leadId).get()).data();
  if (!lead) {
    const withProfile = await leads.where('status', 'in', ['sent', 'accepted', 'messaged']).limit(20).get();
    lead = withProfile.docs.map((d) => d.data()).find((x) => x.profile);
  }
  const sample = !lead;
  if (!lead) {
    lead = {
      name: 'Alex Sample',
      profile: 'Alex Sample\nFounder at Sample Hair Clinic\nDubai, United Arab Emirates\nAbout: We help patients with FUE and DHI hair transplants. ' +
        'Opened our second clinic this year.\nExperience: Founder, Sample Hair Clinic (2018 - present)',
    };
  }
  try {
    res.json({ message: await writeDm(s, lead), for: lead.name || '', sample });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/leads', adminAuth, async (req, res) => {
  const snap = await leads.orderBy('createdAt', 'desc').limit(2000).get();
  res.json(snap.docs.map((d) => {
    const x = d.data();
    return {
      id: d.id, url: x.url, name: x.name || '', status: x.status, createdAt: x.createdAt, sentAt: x.sentAt || null,
      detail: x.detail || null, attempts: x.attempts || 0, source: x.source || 'manual', matchReason: x.matchReason || null,
      headline: x.headline ? x.headline.slice(0, 160) : null, acceptedAt: x.acceptedAt || null, dmSentAt: x.dmSentAt || null, dmText: x.dmText || null,
    };
  }));
});

app.post('/api/leads', adminAuth, async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, 5000) : [];
  const valid = new Map();
  let invalid = 0;
  for (const it of items) {
    const n = normalizeProfileUrl(it?.url);
    if (!n) { invalid++; continue; }
    if (!valid.has(n.id)) valid.set(n.id, { ...n, name: String(it.name || '').slice(0, 120) });
  }
  const list = [...valid.values()];
  let added = 0, skipped = 0;
  const now = Date.now();
  for (let i = 0; i < list.length; i += 400) {
    const chunk = list.slice(i, i + 400);
    const snaps = await db.getAll(...chunk.map((x) => leads.doc(x.id)));
    const batch = db.batch();
    snaps.forEach((sn, j) => {
      if (sn.exists) { skipped++; return; }
      const x = chunk[j];
      batch.set(sn.ref, { url: x.url, name: x.name, status: 'queued', source: 'manual', createdAt: now + i + j, attempts: 0 });
      added++;
    });
    await batch.commit();
  }
  res.json({ added, skipped, invalid });
});

app.post('/api/leads/:id/requeue', adminAuth, async (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ error: 'bad id' });
  const ref = leads.doc(req.params.id);
  const x = (await ref.get()).data();
  if (!x) return res.status(404).json({ error: 'not found' });
  // DM retries are safe: the sender skips anyone with existing chat history.
  const dm = ['dm_failed', 'dm_skipped'].includes(x.status);
  await ref.update(dm ? { status: 'accepted', claimedAt: null, dmAttempts: 0 } : { status: 'queued', claimedAt: null, attempts: 0 });
  res.json({ ok: true });
});

app.delete('/api/leads/:id', adminAuth, async (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ error: 'bad id' });
  await leads.doc(req.params.id).delete();
  res.json({ ok: true });
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use((err, req, res, _next) => {
  console.error(err);
  const notFound = err?.code === 5;
  res.status(notFound ? 404 : 500).json({ error: notFound ? 'not found' : 'server error' });
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`LinkPilot API on :${port}`));
