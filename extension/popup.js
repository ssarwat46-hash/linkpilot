const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);
let server = null;

const time = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const ago = (ms) => {
  const m = Math.round((Date.now() - ms) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};
const OUTCOME = {
  sent: 'request sent', already_pending: 'already pending', already_connected: 'already connected',
  no_connect_button: 'no Connect button', email_required: 'needs email, skipped', dm_sent: 'message sent',
  dm_already_messaged: 'had a chat already, skipped', dm_uncertain: 'message not confirmed',
};

function show(view) {
  $('home').classList.toggle('hidden', view !== 'home');
  $('setup').classList.toggle('hidden', view !== 'setup');
}

function pill(cls, text) {
  $('statePill').querySelector('.dot').className = `dot ${cls}`;
  $('statePill').querySelector('span:last-child').textContent = text;
}

function bar(el, n, max) { el.style.width = `${max ? Math.min(100, (n / max) * 100) : 0}%`; }

function showLocal(status) {
  const text = status?.text || 'Nothing yet';
  $('nowText').textContent = text.replace(/^Waiting: /, 'Waiting: ');
  $('nowWhen').textContent = status?.at ? `Updated ${ago(status.at)}` : '';
  $('nowDot').classList.toggle('live', /^(Connecting|Messaging|Searching|Checking)/.test(text));
}

function render(d) {
  server = d;
  $('sReq').innerHTML = `${d.today}<small>/${d.dailyLimit}</small>`;
  $('sDm').innerHTML = `${d.dmsToday}<small>/${d.dmDailyLimit}</small>`;
  bar($('barReq'), d.today, d.dailyLimit);
  bar($('barDm'), d.dmsToday, d.dmDailyLimit);
  $('sQueue').textContent = d.queued;
  $('sAcc').textContent = d.accepted;

  if (d.paused) pill('', 'Paused');
  else if (d.pausedUntil) pill('warn', `Auto-paused till ${time(d.pausedUntil)}`);
  else if (!d.activeNow) pill('warn', `Off hours (${d.window})`);
  else pill('ok', 'Running');

  const t = $('toggle');
  t.disabled = false;
  t.textContent = d.paused ? 'Start' : 'Pause';
  t.className = d.paused ? 'btn' : 'btn stop';

  $('nextText').textContent = d.today >= d.dailyLimit ? `Done for today (${d.dailyLimit} sent)`
    : d.nextInviteAt ? `Around ${time(d.nextInviteAt)}`
      : d.paused ? 'When you press Start' : !d.activeNow ? `Next active window (${d.window})` : 'Within a couple of minutes';
  $('weekText').textContent = `${d.week}/${d.weeklyLimit} this week` +
    (d.lastResult ? ` · Last: ${d.lastResult.name || 'someone'}, ${OUTCOME[d.lastResult.outcome] || d.lastResult.outcome.replace(/_/g, ' ')} (${ago(d.lastResult.at)})` : '');

  const alerts = [];
  if (d.lastError) alerts.push(['bad', d.lastError]);
  if (!d.aiReady) alerts.push(['warn', 'AI not connected. Sign in with ChatGPT in the dashboard to turn on finding people and messages.']);
  else if (!d.hasCampaign) alerts.push(['warn', 'No campaign prompt yet. Add one in the dashboard so it can find people.']);
  $('alerts').innerHTML = '';
  for (const [cls, text] of alerts) {
    const div = document.createElement('div');
    div.className = `alert ${cls}`;
    div.textContent = text;
    $('alerts').appendChild(div);
  }
}

async function refresh() {
  const r = await send({ type: 'status' });
  if (r?.ok) render(r.data);
  else { pill('bad', 'Not connected'); $('toggle').disabled = true; $('nowText').textContent = r?.error || 'No response'; }
}

async function load() {
  const { apiUrl = '', token = '', status } = await chrome.storage.local.get(['apiUrl', 'token', 'status']);
  $('apiUrl').value = apiUrl;
  $('token').value = token;
  showLocal(status);
  if (!apiUrl || !token) { pill('', 'Not set up'); show('setup'); return; }
  show('home');
  await refresh();
}

chrome.storage.onChanged.addListener((c) => {
  if (c.status) { showLocal(c.status.newValue); refresh(); }
});

$('gear').onclick = () => show($('setup').classList.contains('hidden') ? 'setup' : 'home');
$('back').onclick = () => show('home');

$('save').onclick = async () => {
  await chrome.storage.local.set({ apiUrl: $('apiUrl').value.trim().replace(/\/+$/, ''), token: $('token').value.trim() });
  $('msg').textContent = 'Testing…';
  const r = await send({ type: 'test' });
  $('msg').textContent = r?.text || 'No response';
  if (r?.ok) { show('home'); refresh(); }
};

$('toggle').onclick = async () => {
  if (!server) return;
  $('toggle').disabled = true;
  const r = await send({ type: 'pause', paused: !server.paused });
  if (!r?.ok) $('nowText').textContent = r?.error || 'Could not change';
  await refresh();
};

$('run').onclick = async () => {
  $('run').disabled = true;
  $('nowText').textContent = 'Checking for work…';
  await send({ type: 'runNow' });
  $('run').disabled = false;
  refresh();
};

$('open').onclick = async () => {
  const { apiUrl } = await chrome.storage.local.get('apiUrl');
  if (apiUrl) chrome.tabs.create({ url: apiUrl });
};

load();
setInterval(refresh, 30000);
