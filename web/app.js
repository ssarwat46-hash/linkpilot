const $ = (id) => document.getElementById(id);
const SESSION_KEY = 'linkpilot_session';
const getSession = () => { try { return localStorage.getItem(SESSION_KEY) || ''; } catch { return ''; } };
const setSession = (t) => { try { t ? localStorage.setItem(SESSION_KEY, t) : localStorage.removeItem(SESSION_KEY); } catch { /* private mode */ } };
let devices = [];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const NUMERIC = new Set(['dailyLimit', 'weeklyLimit', 'minGapMin', 'maxGapMin', 'dmDailyLimit', 'searchesPerDay']);
let settings = null;
let allLeads = [];
const dirty = new Set(); // fields edited but not saved yet: the 30s refresh must not overwrite them

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getSession()}`, ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/login') { showLogin('Signed out. Sign in again.'); throw new Error('Signed out'); }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const fmt = (ms) => (ms ? new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '-');
const ago = (ms) => {
  if (!ms) return 'never';
  const m = Math.round((Date.now() - ms) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};

function setPill(el, cls, text) {
  el.querySelector('.dot').className = `dot ${cls}`;
  el.querySelector('span:last-child').textContent = text;
}

function renderPlan(plan) {
  $('plan').innerHTML = plan?.queries?.length
    ? `<span class="muted" style="font-size:12px">${esc(plan.summary || 'Searches')}:</span>` + plan.queries.map((q) => `<span class="chip">${esc(q)}</span>`).join('')
    : '';
}

async function loadStats() {
  const s = await api('/api/stats');
  settings = s.settings;
  $('sToday').textContent = `${s.today}/${settings.dailyLimit}`;
  $('sWeek').textContent = `${s.week}/${settings.weeklyLimit}`;
  $('sQueued').textContent = s.queued;
  $('sAccepted').textContent = s.accepted;
  $('sDms').textContent = `${s.dmsToday}/${settings.dmDailyLimit}`;

  const st = s.state || {};
  devices = s.devices || [];
  const online = devices.filter((d) => d.lastSeen && Date.now() - d.lastSeen < 10 * 60000).length;
  setPill($('extPill'), online ? 'ok' : 'bad', `${online}/${devices.length} browser${devices.length === 1 ? '' : 's'} online`);

  if (settings.paused) setPill($('runPill'), '', 'Paused');
  else if (!s.activeNow) setPill($('runPill'), 'warn', 'Running (outside hours)');
  else setPill($('runPill'), 'ok', 'Running');
  $('toggle').textContent = settings.paused ? 'Start' : 'Pause';

  const nexts = devices.map((d) => d.nextAllowedAt).filter(Boolean).sort();
  const next = nexts.length ? fmt(nexts[0]) : (devices.find((d) => d.lastWait)?.lastWait || '-');
  $('sNext').textContent = next;
  $('sNext').style.fontSize = next.length > 12 ? '14px' : '';
  renderDevices(settings);

  const lr = devices.map((d) => d.lastResult && { ...d.lastResult, browser: d.name }).filter(Boolean).sort((a, b) => b.at - a.at)[0];
  const ls = st.lastSearch;
  $('lastResult').textContent = [
    lr ? `Last (${lr.browser}): ${lr.name || lr.leadId} → ${lr.outcome}${lr.detail ? ` (${lr.detail})` : ''}, ${ago(lr.at)}` : '',
    ls ? `Last search: ${ls.found} seen, ${ls.added} added, ${ls.skipped} skipped by AI, ${ago(ls.at)}` : '',
  ].filter(Boolean).join(' · ');

  const err = st.lastError || null;
  $('alert').textContent = err || '';
  $('alert').classList.toggle('hidden', !err);

  renderPlan(st.searchPlan);
  fillSettings();
}

function renderDevices(s) {
  $('devEmpty').classList.toggle('hidden', devices.length > 0);
  $('devRows').innerHTML = devices.map((d) => {
    const on = d.lastSeen && Date.now() - d.lastSeen < 10 * 60000;
    const status = d.pausedUntil ? `<span class="tag failed">paused till ${fmt(d.pausedUntil)}</span>`
      : `<span class="tag ${on ? 'sent' : ''}">${on ? 'online' : 'offline'}</span> <span class="muted" style="font-size:12px">${ago(d.lastSeen)}</span>`;
    return `<tr>
      <td><div>${esc(d.name)}</div>${d.lastError ? `<div class="muted" style="font-size:12px;color:#fca5a5">${esc(d.lastError)}</div>` : d.lastWait ? `<div class="muted" style="font-size:12px">${esc(d.lastWait)}</div>` : ''}</td>
      <td>${d.today}/${s.dailyLimit}</td><td>${d.week}/${s.weeklyLimit}</td><td>${d.dmsToday}/${s.dmDailyLimit}</td>
      <td>${status}</td>
      <td class="row" style="justify-content:flex-end">
        ${d.pausedUntil || d.lastError ? `<button class="ghost" data-dev="clear" data-id="${esc(d.id)}">Clear pause</button>` : ''}
        <button class="ghost" data-dev="rename" data-id="${esc(d.id)}">Rename</button>
        <button class="ghost" data-dev="remove" data-id="${esc(d.id)}">Sign out</button>
      </td></tr>`;
  }).join('');
}

$('devRows').onclick = async (e) => {
  const b = e.target.closest('button[data-dev]');
  if (!b) return;
  const d = devices.find((x) => x.id === b.dataset.id);
  try {
    if (b.dataset.dev === 'rename') {
      const name = prompt('Name for this browser', d?.name || '');
      if (name == null) return;
      await api(`/api/devices/${encodeURIComponent(b.dataset.id)}`, { method: 'PUT', body: { name } });
    } else if (b.dataset.dev === 'clear') {
      await api(`/api/devices/${encodeURIComponent(b.dataset.id)}`, { method: 'PUT', body: { clearPause: true } });
    } else if (b.dataset.dev === 'remove') {
      if (!confirm(`Sign out "${d?.name}"? That browser stops working until someone logs in on it again.`)) return;
      await api(`/api/devices/${encodeURIComponent(b.dataset.id)}`, { method: 'DELETE' });
    }
    await loadStats();
  } catch (err) { alert(err.message); }
};

function fillSettings() {
  for (const el of document.querySelectorAll('[data-k]')) {
    const k = el.dataset.k;
    if (dirty.has(k) || document.activeElement === el) continue;
    if (el.type === 'checkbox') el.checked = !!settings[k];
    else el.value = settings[k] ?? '';
  }
  if (!dirty.has('activeDays')) {
    $('days').innerHTML = DAYS.map((d, i) => `<label><input type="checkbox" value="${i}" ${settings.activeDays.includes(i) ? 'checked' : ''}>${d}</label>`).join('');
  }
}

async function loadLeads() {
  allLeads = await api('/api/leads');
  renderLeads();
}

function renderLeads() {
  const f = $('filter').value;
  const list = f ? allLeads.filter((l) => l.status === f) : allLeads;
  $('rows').innerHTML = list.slice(0, 500).map((l) => `
    <tr>
      <td>${l.name ? `<div>${esc(l.name)}</div>` : ''}<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.url.replace('https://www.linkedin.com', ''))}</a>
        ${l.matchReason ? `<div class="muted" style="font-size:12px">AI: ${esc(l.matchReason)}</div>` : ''}
        ${l.detail ? `<div class="muted" style="font-size:12px">${esc(l.detail)}</div>` : ''}
        ${l.dmText ? `<div class="note" style="font-size:12px;margin-top:6px">${esc(l.dmText)}</div>` : ''}</td>
      <td><span class="tag ${esc(l.status)}">${esc(l.status.replace(/_/g, ' '))}</span>${l.source === 'search' ? '<div class="muted" style="font-size:11px;margin-top:4px">found by AI</div>' : ''}</td>
      <td class="muted">${fmt(l.createdAt)}</td>
      <td class="muted">${fmt(l.sentAt)}${l.dmSentAt ? `<div>DM ${fmt(l.dmSentAt)}</div>` : ''}</td>
      <td class="muted">${esc(devices.find((d) => d.id === l.deviceId)?.name || (l.deviceId ? 'removed browser' : '-'))}</td>
      <td class="row" style="justify-content:flex-end">
        ${['failed', 'no_connect_button', 'email_required', 'ai_skipped', 'dm_failed', 'dm_skipped'].includes(l.status) ? `<button class="ghost" data-act="requeue" data-id="${esc(l.id)}">Retry</button>` : ''}
        <button class="ghost" data-act="delete" data-id="${esc(l.id)}">Delete</button>
      </td>
    </tr>`).join('');
  $('count').textContent = `${list.length} lead${list.length === 1 ? '' : 's'}${list.length > 500 ? ' (showing first 500)' : ''}`;
}

function parseLeadLines(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const cells = line.split(/[,\t;]/).map((c) => c.trim().replace(/^"|"$/g, ''));
    const urlCell = cells.find((c) => /linkedin\.com\/in\//i.test(c));
    if (!urlCell) continue;
    out.push({ url: urlCell, name: cells.filter((c) => c && c !== urlCell).join(' ') });
  }
  return out;
}

async function addLeads(text) {
  const items = parseLeadLines(text);
  if (!items.length) { $('addMsg').textContent = 'No LinkedIn profile URLs found.'; return; }
  $('addLeads').disabled = true;
  $('addMsg').textContent = 'Adding...';
  try {
    const r = await api('/api/leads', { method: 'POST', body: { items } });
    $('addMsg').textContent = `Added ${r.added}. Skipped ${r.skipped} already known${r.invalid ? `, ${r.invalid} bad URLs` : ''}.`;
    $('leadText').value = '';
    await Promise.all([loadLeads(), loadStats()]);
  } catch (e) {
    $('addMsg').textContent = e.message;
  } finally {
    $('addLeads').disabled = false;
  }
}

async function saveSettings(extra = {}) {
  const body = {};
  for (const el of document.querySelectorAll('[data-k]')) {
    const k = el.dataset.k;
    body[k] = el.type === 'checkbox' ? el.checked : NUMERIC.has(k) ? +el.value : el.value.trim();
  }
  body.activeDays = [...$('days').querySelectorAll('input:checked')].map((x) => +x.value);
  Object.assign(body, extra);
  settings = await api('/api/settings', { method: 'PUT', body });
  dirty.clear();
  await loadStats();
}

// ---------- wiring ----------
$('login').onsubmit = async (e) => {
  e.preventDefault();
  $('signin').disabled = true;
  $('loginErr').textContent = 'Signing in...';
  try {
    const r = await api('/api/login', { method: 'POST', body: { username: $('username').value, password: $('password').value } });
    setSession(r.token);
    $('password').value = '';
    $('loginErr').textContent = '';
    await start();
  } catch (err) { $('loginErr').textContent = err.message; }
  $('signin').disabled = false;
};
$('signout').onclick = () => { setSession(''); showLogin(''); };
$('addLeads').onclick = () => addLeads($('leadText').value);
$('csv').onchange = async (e) => { const f = e.target.files[0]; if (f) await addLeads(await f.text()); e.target.value = ''; };
$('filter').onchange = renderLeads;
$('refresh').onclick = () => Promise.all([loadLeads(), loadStats()]);
document.addEventListener('input', (e) => {
  if (e.target.dataset?.k) dirty.add(e.target.dataset.k);
  if (e.target.closest?.('#days')) dirty.add('activeDays');
});
for (const b of document.querySelectorAll('button.save')) {
  b.onclick = async () => {
    const msg = b.parentElement.querySelector('span.muted');
    if (msg) msg.textContent = 'Saving...';
    try { await saveSettings(); if (msg) msg.textContent = 'Saved.'; } catch (e) { if (msg) msg.textContent = e.message; }
  };
}
$('toggle').onclick = async () => {
  $('toggle').disabled = true;
  try { await saveSettings({ paused: !settings.paused, clearAutoPause: settings.paused }); } catch (e) { alert(e.message); }
  $('toggle').disabled = false;
};
$('planBtn').onclick = async () => {
  $('planMsg').textContent = 'Saving and asking the AI...';
  try { await saveSettings(); renderPlan(await api('/api/campaign/plan', { method: 'POST' })); $('planMsg').textContent = ''; } catch (e) { $('planMsg').textContent = e.message; }
};
$('previewBtn').onclick = async () => {
  $('previewMsg').textContent = 'Saving and writing...';
  try {
    await saveSettings();
    const r = await api('/api/ai/preview-dm', { method: 'POST', body: {} });
    $('preview').textContent = r.message;
    $('preview').classList.remove('hidden');
    $('previewMsg').textContent = r.sample ? 'Sample profile (no real one captured yet).' : `Written for ${r.for}. Not sent.`;
  } catch (e) { $('previewMsg').textContent = e.message; }
};
async function loadAi() {
  const a = await api('/api/ai');
  const g = a.chatgpt;
  $('gptOn').classList.toggle('hidden', !g.connected);
  $('gptOff').classList.toggle('hidden', g.connected);
  let text, color;
  if (g.connected) { text = `Connected to ChatGPT${g.email ? ` as ${g.email}` : ''}.`; color = 'var(--ok)'; }
  else if (g.needsSignIn) { text = 'ChatGPT sign-in expired. Sign in again.'; color = 'var(--bad)'; }
  else if (a.apiKey.connected) { text = `Using an OpenAI API key (…${a.apiKey.last4}).`; color = 'var(--ok)'; }
  else { text = 'Not connected. Finding people and messages wait until you sign in.'; color = 'var(--warn)'; }
  $('aiStatus').textContent = text;
  $('aiStatus').style.color = color;
  $('gptModel').innerHTML = (g.models.length ? g.models : [g.model || '']).map((m) => `<option ${m === g.model ? 'selected' : ''}>${esc(m)}</option>`).join('');
}

$('gptStart').onclick = async () => {
  $('gptMsg').textContent = '';
  try {
    const { url } = await api('/api/ai/chatgpt/start', { method: 'POST' });
    window.open(url, '_blank', 'noopener');
    $('gptStep2').classList.remove('hidden');
    $('gptCallback').focus();
  } catch (e) { $('gptMsg').textContent = e.message; }
};
$('gptFinish').onclick = async () => {
  $('gptMsg').textContent = 'Finishing sign-in...';
  try {
    await api('/api/ai/chatgpt/finish', { method: 'POST', body: { callbackUrl: $('gptCallback').value } });
    $('gptCallback').value = '';
    $('gptStep2').classList.add('hidden');
    $('gptMsg').textContent = 'Signed in.';
    await Promise.all([loadAi(), loadStats()]);
  } catch (e) { $('gptMsg').textContent = e.message; }
};
$('gptModel').onchange = async () => {
  try { await api('/api/ai/chatgpt/model', { method: 'PUT', body: { model: $('gptModel').value } }); $('gptMsg').textContent = 'Model saved.'; } catch (e) { $('gptMsg').textContent = e.message; }
};
$('gptDisconnect').onclick = async () => {
  if (!confirm('Disconnect ChatGPT? Finding people and messages will stop.')) return;
  try { await api('/api/ai/chatgpt', { method: 'DELETE' }); $('gptMsg').textContent = 'Disconnected.'; await Promise.all([loadAi(), loadStats()]); } catch (e) { $('gptMsg').textContent = e.message; }
};

$('saveKey').onclick = async () => {
  $('keyMsg').textContent = 'Checking key...';
  try { await api('/api/ai', { method: 'PUT', body: { key: $('aiKey').value } }); $('aiKey').value = ''; $('keyMsg').textContent = 'Saved.'; await Promise.all([loadAi(), loadStats()]); } catch (e) { $('keyMsg').textContent = e.message; }
};
$('clearKey').onclick = async () => {
  if (!confirm('Remove the OpenAI API key?')) return;
  try { await api('/api/ai', { method: 'PUT', body: { key: '' } }); $('keyMsg').textContent = 'Removed.'; await Promise.all([loadAi(), loadStats()]); } catch (e) { $('keyMsg').textContent = e.message; }
};
$('rows').onclick = async (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const { act, id } = b.dataset;
  if (act === 'delete' && !confirm('Delete this lead? It could then be found and contacted again.')) return;
  b.disabled = true;
  try {
    if (act === 'requeue') await api(`/api/leads/${encodeURIComponent(id)}/requeue`, { method: 'POST' });
    if (act === 'delete') await api(`/api/leads/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await Promise.all([loadLeads(), loadStats()]);
  } catch (err) { alert(err.message); b.disabled = false; }
};

let timer = null;
function showLogin(msg) {
  clearInterval(timer);
  setSession('');
  $('who').textContent = '';
  $('signout').classList.add('hidden');
  $('app').classList.add('hidden');
  $('login').classList.remove('hidden');
  $('loginErr').textContent = msg || '';
}

async function start() {
  if (!getSession()) return showLogin('');
  const me = await api('/api/me');
  $('who').textContent = me.user;
  $('signout').classList.remove('hidden');
  $('login').classList.add('hidden');
  $('app').classList.remove('hidden');
  await loadStats();
  await Promise.all([loadLeads(), loadAi()]);
  clearInterval(timer);
  timer = setInterval(() => loadStats().catch(() => {}), 30000);
}

start().catch(() => {});
