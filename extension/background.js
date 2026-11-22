import { connectOnProfile, scrapeSearch, scrapeConnections, sendDm } from './linkedin.js';
import { DASHBOARD_URL } from './config.js';

const ALARM = 'linkpilot-tick';
const VERSION = chrome.runtime.getManifest().version;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);

function ensureAlarm() {
  chrome.alarms.get(ALARM, (a) => { if (!a) chrome.alarms.create(ALARM, { delayInMinutes: 1, periodInMinutes: 2 }); });
}
chrome.runtime.onInstalled.addListener(ensureAlarm);
chrome.runtime.onStartup.addListener(ensureAlarm);
ensureAlarm();

chrome.alarms.onAlarm.addListener((a) => { if (a.name === ALARM) tick(); });
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type === 'runNow') { tick(true).then(() => reply({ ok: true })); return true; }
  if (msg?.type === 'test') { testConnection().then(reply); return true; }
  if (msg?.type === 'login') { login(msg).then(reply); return true; }
  if (msg?.type === 'logout') { chrome.storage.local.remove(['deviceToken', 'deviceName', 'status']).then(() => reply({ ok: true })); return true; }
  if (msg?.type === 'defaults') { cfg().then((c) => reply({ apiUrl: c.apiUrl, signedIn: !!c.token })); return true; }
  if (msg?.type === 'status') { api('/api/ext/status', {}).then((d) => reply({ ok: true, data: d }), (e) => reply({ ok: false, error: e.message })); return true; }
  if (msg?.type === 'pause') { api('/api/ext/pause', { paused: !!msg.paused }).then((d) => reply({ ok: true, data: d }), (e) => reply({ ok: false, error: e.message })); return true; }
});

async function cfg() {
  const { apiUrl = '', deviceToken = '' } = await chrome.storage.local.get(['apiUrl', 'deviceToken']);
  return { apiUrl: (apiUrl || DASHBOARD_URL || '').replace(/\/+$/, ''), token: deviceToken };
}

async function api(path, body) {
  const { apiUrl, token } = await cfg();
  if (!apiUrl || !token) throw new Error('Not logged in. Open the extension and log in.');
  const res = await fetch(`${apiUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Device-Token': token },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) await chrome.storage.local.remove('deviceToken'); // removed in the dashboard: log in again
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// Log this browser in with the dashboard username/password. Only the per-browser key is stored, never the password.
async function login({ username, password, name, apiUrl }) {
  const base = String(apiUrl || DASHBOARD_URL || '').trim().replace(/\/+$/, '');
  if (!/^https:\/\//.test(base)) return { ok: false, text: 'Dashboard address is missing.' };
  try {
    const res = await fetch(`${base}/api/ext/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, name, version: VERSION }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, text: data.error || `HTTP ${res.status}` };
    await chrome.storage.local.set({ apiUrl: base, deviceToken: data.deviceToken, deviceName: data.name });
    await chrome.storage.local.remove('token'); // old shared token from v2.0
    return testConnection();
  } catch (e) {
    return { ok: false, text: `Could not reach the dashboard: ${e.message}` };
  }
}

// Results must reach the server, or counts and the never-twice rule drift. Retry once.
async function report(path, body) {
  try { return await api(path, body); } catch { await sleep(5000); return api(path, body); }
}

async function setStatus(text) {
  await chrome.storage.local.set({ status: { text, at: Date.now() } });
}

async function testConnection() {
  try {
    const r = await api('/api/ext/ping', { version: VERSION });
    const state = r.paused ? 'Paused in dashboard.' : r.activeNow ? 'Running.' : 'Outside active hours.';
    return { ok: true, text: `Logged in as "${r.name}". ${r.queued} in queue. ${state}${r.aiReady ? "" : " (AI not connected yet)"}` };
  } catch (e) {
    return { ok: false, text: e.message };
  }
}

async function tick() {
  const { busyUntil = 0 } = await chrome.storage.local.get('busyUntil');
  if (busyUntil > Date.now()) return;
  await chrome.storage.local.set({ busyUntil: Date.now() + 5 * 60000 });
  try {
    const { apiUrl, token } = await cfg();
    if (!apiUrl || !token) { await setStatus('Not logged in'); return; }

    const r = await api('/api/ext/claim', { version: VERSION });
    const task = r.task || (r.lead ? { type: 'connect', lead: r.lead } : null);
    if (!task) { await setStatus(`Waiting: ${r.wait}`); return; }

    if (task.type === 'connect') {
      const who = task.lead.name || task.lead.url;
      await setStatus(`Connecting with ${who}`);
      const { result, finalUrl } = await runInTab(task.lead.url, connectOnProfile, []);
      const res = result || { outcome: 'error', detail: 'no result from page' };
      await report('/api/ext/result', { id: task.lead.id, outcome: res.outcome, detail: res.detail || null, profile: res.profile || null, finalUrl });
      await setStatus(`${who} → ${res.outcome}${res.detail ? ` (${res.detail})` : ''}`);
    } else if (task.type === 'dm') {
      const who = task.lead.name || task.lead.url;
      await setStatus(`Messaging ${who}`);
      const { result } = await runInTab(task.lead.url, sendDm, [task.message]);
      const res = result || { outcome: 'error', detail: 'no result from page' };
      await report('/api/ext/dm-result', { id: task.lead.id, outcome: res.outcome, detail: res.detail || null });
      await setStatus(`DM to ${who} → ${res.outcome}${res.detail ? ` (${res.detail})` : ''}`);
    } else if (task.type === 'search') {
      await setStatus('Searching LinkedIn for new people');
      const { result } = await runInTab(task.url, scrapeSearch, []);
      const res = result || { error: 'no result from page' };
      const out = await report('/api/ext/search-result', { key: task.key, results: res.results || [], error: res.error || null });
      await setStatus(res.error ? `Search: ${res.error}` : `Search: ${res.results.length} seen, ${out.added || 0} added to queue`);
    } else if (task.type === 'accept_check') {
      await setStatus('Checking who accepted');
      const { result } = await runInTab(task.url, scrapeConnections, []);
      const res = result || { error: 'no result from page' };
      const out = await report('/api/ext/accepted', { hrefs: res.hrefs || [], error: res.error || null });
      await setStatus(res.error ? `Accept check: ${res.error}` : `Accept check: ${out.accepted || 0} new`);
    } else {
      await setStatus(`Unknown task ${task.type}. Update the extension.`);
    }
  } catch (e) {
    await setStatus(`Error: ${e.message}`);
  } finally {
    await chrome.storage.local.set({ busyUntil: 0 });
  }
}

function waitTabComplete(tabId, timeout) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { chrome.tabs.onUpdated.removeListener(fn); reject(new Error('page load timeout')); }, timeout);
    function fn(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(t);
        chrome.tabs.onUpdated.removeListener(fn);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(fn);
    chrome.tabs.get(tabId, (tab) => { if (tab?.status === 'complete') fn(tabId, { status: 'complete' }); });
  });
}

// Open a background tab, run one injected function, close the tab.
async function runInTab(url, func, args) {
  let tabId = null;
  try {
    const tab = await chrome.tabs.create({ url, active: false });
    tabId = tab.id;
    await waitTabComplete(tabId, 45000);
    await sleep(rand(3000, 6000));
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
    const finalUrl = (await chrome.tabs.get(tabId))?.url || null;
    return { result: res?.result, finalUrl };
  } catch (e) {
    return { result: { outcome: 'error', error: String(e.message || e), detail: String(e.message || e) }, finalUrl: null };
  } finally {
    await sleep(rand(1500, 4000));
    if (tabId != null) chrome.tabs.remove(tabId).catch(() => {});
  }
}
