// Each exported function is injected into a LinkedIn tab with chrome.scripting.executeScript,
// so every one of them must be fully self-contained (no shared helpers outside the function).

// Connect on a profile page, WITHOUT a note.
// Returns { outcome, detail, profile } where outcome is one of:
// sent | already_pending | already_connected | no_connect_button | email_required | weekly_limit | logged_out | error
export async function connectOnProfile() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (a, b) => a + Math.random() * (b - a);
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const visible = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const label = (el) => norm(el.getAttribute('aria-label') || el.innerText || el.textContent);
  const text = (el) => norm(el.innerText || el.textContent);
  const waitFor = async (fn, timeout = 10000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) { const r = fn(); if (r) return r; await sleep(300); }
    return null;
  };
  const dialogs = () => [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], .artdeco-modal')].filter(visible);
  const dismiss = async (d) => {
    const x = d && [...d.querySelectorAll('button')].find((b) => /^dismiss$|^close$|^cancel$/.test(label(b)));
    if (x) { x.click(); await sleep(500); }
  };
  let profile = null;
  const done = (o) => ({ ...o, profile });

  const p = location.pathname;
  if (/^\/checkpoint/.test(p)) return { outcome: 'security_check' };
  if (/^\/(login|authwall|uas)/.test(p)) return { outcome: 'logged_out' };
  if (!p.startsWith('/in/')) return { outcome: 'error', detail: `not a profile page (${p})` };

  const main = await waitFor(() => document.querySelector('main'), 20000);
  if (!main) return { outcome: 'error', detail: 'profile did not load' };
  if (/this page doesn.t exist|profile is not available|page not found/.test(text(main).slice(0, 2000))) {
    return { outcome: 'no_connect_button', detail: 'profile not found' };
  }

  const topCard = await waitFor(() => {
    const sections = [...main.querySelectorAll('section')].filter(visible);
    return sections.find((s) => [...s.querySelectorAll('button')].some((b) => /connect|message|follow|pending|more/.test(label(b)))) || null;
  }, 15000);
  if (!topCard) return { outcome: 'error', detail: 'could not find profile buttons' };

  // Read the profile like a person would: scroll down so About/Experience load, then back up.
  await sleep(rand(1500, 3500));
  for (let y = 0; y < 3; y++) { window.scrollBy({ top: rand(400, 700), behavior: 'smooth' }); await sleep(rand(900, 1600)); }
  const skip = /^(connect|message|more|follow|following|pending|show all.*|see more|…see more|\d+ (followers|connections)|contact info|send profile in a message|save to pdf)$/i;
  profile = (main.innerText || '').split('\n').map((l) => l.trim()).filter((l) => l && l.length > 1 && !skip.test(l))
    .filter((l, i, a) => a.indexOf(l) === i).join('\n').slice(0, 4500);
  window.scrollTo({ top: 0, behavior: 'smooth' });
  await sleep(rand(800, 1500));

  const cardButtons = () => [...topCard.querySelectorAll('button, a[role="button"], div[role="button"]')].filter(visible);
  const isConnect = (b) => /^invite .+ to connect$/.test(label(b)) || text(b) === 'connect';
  const isPending = (b) => /^pending/.test(label(b)) || /withdraw invitation/.test(label(b)) || text(b) === 'pending';

  if (cardButtons().some(isPending)) return done({ outcome: 'already_pending' });

  let connectBtn = cardButtons().find(isConnect);

  // Connect is often hidden under the "More" menu.
  if (!connectBtn) {
    const more = cardButtons().find((b) => /^more actions$|^more$/.test(label(b)) || text(b) === 'more');
    if (more) {
      more.click();
      await sleep(rand(900, 1600));
      const items = [...document.querySelectorAll('[role="menu"] [role="button"], [role="menu"] [role="menuitem"], .artdeco-dropdown__content [role="button"], .artdeco-dropdown__item')].filter(visible);
      connectBtn = items.find(isConnect);
      if (!connectBtn) {
        const pending = items.some((i) => /pending|withdraw/.test(label(i)));
        const connected = items.some((i) => /remove connection/.test(label(i)));
        more.click();
        if (pending) return done({ outcome: 'already_pending' });
        if (connected) return done({ outcome: 'already_connected' });
      }
    }
  }

  if (!connectBtn) {
    if (/·\s*1st\b|\b1st degree connection/.test(text(topCard))) return done({ outcome: 'already_connected' });
    return done({ outcome: 'no_connect_button', detail: 'no Connect option on this profile' });
  }

  connectBtn.click();

  const modal = await waitFor(() => dialogs()[0] || null, 8000);
  if (!modal) {
    await sleep(1500);
    if (cardButtons().some(isPending)) return done({ outcome: 'sent', detail: 'sent directly' });
    return done({ outcome: 'error', detail: 'invite dialog did not open' });
  }

  const mtext = text(modal);
  if (/weekly invitation limit|reached the weekly|invitation limit/.test(mtext)) { await dismiss(modal); return done({ outcome: 'weekly_limit' }); }
  if (modal.querySelector('input[type="email"], input[name="email"]')) { await dismiss(modal); return done({ outcome: 'email_required' }); }

  await sleep(rand(800, 1700));
  const mButtons = [...modal.querySelectorAll('button')].filter(visible);
  const sendBtn =
    mButtons.find((b) => /send without a note/.test(label(b))) ||
    mButtons.find((b) => /^send( now| invitation)?$/.test(label(b)) || /^send( now| invitation)?$/.test(text(b)));
  if (!sendBtn) { await dismiss(modal); return done({ outcome: 'error', detail: `send button not found (dialog: ${mtext.slice(0, 80)})` }); }
  if (sendBtn.disabled) { await dismiss(modal); return done({ outcome: 'error', detail: 'send button disabled' }); }

  sendBtn.click();
  await sleep(rand(1800, 3000));

  for (const d of dialogs()) {
    const t = text(d);
    if (/weekly invitation limit|invitation limit|reached the weekly/.test(t)) { await dismiss(d); return done({ outcome: 'weekly_limit' }); }
    if (d.querySelector('input[type="email"]')) { await dismiss(d); return done({ outcome: 'email_required' }); }
  }
  return done({ outcome: 'sent' });
}

// Read one page of LinkedIn people-search results.
// Returns { results: [{ url, text }] } or { error }.
export async function scrapeSearch() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (a, b) => a + Math.random() * (b - a);
  const waitFor = async (fn, timeout = 10000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) { const r = fn(); if (r) return r; await sleep(300); }
    return null;
  };
  if (/^\/checkpoint/.test(location.pathname)) return { error: 'security_check' };
  if (/^\/(login|authwall|uas)/.test(location.pathname)) return { error: 'logged_out' };
  const main = await waitFor(() => document.querySelector('main'), 20000);
  if (!main) return { error: 'search page did not load' };
  const profileLinks = () => [...main.querySelectorAll('a[href*="/in/"]')];
  await waitFor(() => profileLinks().length > 0 || /no results found|try removing filters/i.test(main.innerText), 15000);
  if (/no results found/i.test(main.innerText) && !profileLinks().length) return { results: [], debug: { noResults: true, path: location.pathname + location.search.slice(0, 120), mainText: main.innerText.replace(/\s+/g, ' ').slice(0, 600) } };

  // Scroll through the page like a person reading it, so every card renders.
  for (let i = 0; i < 6; i++) { window.scrollBy({ top: rand(350, 600), behavior: 'smooth' }); await sleep(rand(700, 1400)); }
  window.scrollTo({ top: 0, behavior: 'smooth' });
  await sleep(rand(500, 1000));

  const junk = /^(connect|message|follow|view .+ profile|status is \w+|•|·|\d+(st|nd|rd|th)\+?|\d+(st|nd|rd|th) degree connection|current:|past:|summary:)$/i;
  const slugOf = (a) => { try { return new URL(a.href, location.origin).pathname.match(/^\/in\/([^/]+)/)?.[1] || null; } catch { return null; } };
  // The result card is the biggest ancestor that still holds links to only this one person.
  // Class names change all the time, so this only relies on page structure.
  const cardFor = (a, slug) => {
    let card = null;
    for (let el = a.parentElement; el && el !== main; el = el.parentElement) {
      const slugs = new Set([...el.querySelectorAll('a[href*="/in/"]')].map(slugOf).filter(Boolean));
      if (slugs.size > 1 || !slugs.has(slug)) break;
      card = el;
    }
    return card;
  };
  const out = new Map();
  for (const a of profileLinks()) {
    const slug = slugOf(a);
    if (!slug || out.has(slug)) continue;
    const card = cardFor(a, slug);
    if (!card) continue;
    const lines = (card.innerText || '').split('\n').map((l) => l.trim()).filter((l) => l && !junk.test(l));
    const text = [...new Set(lines)].join(' | ').slice(0, 600);
    if (text.length > 15) out.set(slug, { url: `https://www.linkedin.com/in/${slug}/`, text });
  }
  const results = [...out.values()].slice(0, 15);
  // What the page looked like, so a 0-result search can be diagnosed remotely. No names leave the page except the profile text already sent.
  const links = profileLinks();
  const chain = (el) => { const c = []; for (let x = el; x && x !== main && c.length < 12; x = x.parentElement) c.push(`${x.tagName.toLowerCase()}${x.className && typeof x.className === 'string' ? '.' + x.className.trim().split(/\s+/).slice(0, 2).join('.') : ''}`); return c.join(' < '); };
  const debug = {
    path: location.pathname + location.search.slice(0, 120), title: document.title.slice(0, 120), visibility: document.visibilityState,
    links: links.length, slugs: new Set(links.map(slugOf).filter(Boolean)).size, lis: main.querySelectorAll('li').length,
    height: document.documentElement.scrollHeight, firstLinkChain: links[0] ? chain(links[0]) : null,
    mainText: main.innerText.replace(/\s+/g, ' ').slice(0, 1500),
  };
  return { results, debug };
}

// Read the "recently added" connections list. Returns { hrefs } or { error }.
export async function scrapeConnections() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (a, b) => a + Math.random() * (b - a);
  const waitFor = async (fn, timeout = 10000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) { const r = fn(); if (r) return r; await sleep(300); }
    return null;
  };
  if (/^\/checkpoint/.test(location.pathname)) return { error: 'security_check' };
  if (/^\/(login|authwall|uas)/.test(location.pathname)) return { error: 'logged_out' };
  const main = await waitFor(() => document.querySelector('main'), 20000);
  if (!main) return { error: 'connections page did not load' };
  await waitFor(() => main.querySelector('a[href*="/in/"]'), 15000);
  for (let i = 0; i < 4; i++) { window.scrollBy({ top: rand(500, 900), behavior: 'smooth' }); await sleep(rand(900, 1600)); }
  const hrefs = [...new Set([...main.querySelectorAll('a[href*="/in/"]')].map((a) => new URL(a.href, location.origin).pathname))];
  return { hrefs: hrefs.slice(0, 150) };
}

// Send one DM from a profile page. Skips if there is ANY earlier chat history (never double text).
// Returns { outcome, detail }: sent | already_messaged | not_connected | no_message_button | uncertain | logged_out | error
export async function sendDm(message) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (a, b) => a + Math.random() * (b - a);
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const visible = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const label = (el) => norm(el.getAttribute('aria-label') || el.innerText || el.textContent);
  const waitFor = async (fn, timeout = 10000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) { const r = fn(); if (r) return r; await sleep(300); }
    return null;
  };

  const p = location.pathname;
  if (/^\/checkpoint/.test(p)) return { outcome: 'security_check' };
  if (/^\/(login|authwall|uas)/.test(p)) return { outcome: 'logged_out' };
  if (!p.startsWith('/in/')) return { outcome: 'error', detail: `not a profile page (${p})` };
  const main = await waitFor(() => document.querySelector('main'), 20000);
  if (!main) return { outcome: 'error', detail: 'profile did not load' };
  const topCard = await waitFor(() => {
    const sections = [...main.querySelectorAll('section')].filter(visible);
    return sections.find((s) => [...s.querySelectorAll('button, a')].some((b) => /^message|connect|follow|more/.test(label(b)))) || null;
  }, 15000);
  if (!topCard) return { outcome: 'error', detail: 'could not find profile buttons' };
  await sleep(rand(1500, 3000));

  const btns = [...topCard.querySelectorAll('button, a')].filter(visible);
  const connectVisible = btns.some((b) => /^invite .+ to connect$/.test(label(b)) || norm(b.innerText) === 'connect' || /^pending/.test(label(b)));
  const msgBtn = btns.find((b) => /^message\b/.test(label(b)));
  if (!msgBtn) return { outcome: connectVisible ? 'not_connected' : 'no_message_button' };
  if (connectVisible) return { outcome: 'not_connected', detail: 'still shows Connect/Pending' };

  msgBtn.click();
  const editor = await waitFor(() => [...document.querySelectorAll('.msg-form__contenteditable[contenteditable="true"], div[contenteditable="true"][role="textbox"]')].filter(visible).pop(), 12000);
  const anyDialog = [...document.querySelectorAll('[role="dialog"], .artdeco-modal')].filter(visible).map((d) => norm(d.innerText)).join(' ');
  if (!editor) {
    if (/inmail|premium/.test(anyDialog)) return { outcome: 'not_connected', detail: 'LinkedIn wants InMail/Premium' };
    return { outcome: 'error', detail: 'message box did not open' };
  }
  const box = editor.closest('.msg-overlay-conversation-bubble, .msg-convo-wrapper, [class*="msg-overlay-conversation"], [class*="conversation"]') || document;
  const closeBox = async () => {
    const x = [...box.querySelectorAll('button')].find((b) => /close your conversation|^close/.test(label(b)));
    if (x) { x.click(); await sleep(600); }
  };
  const history = () => box.querySelectorAll('.msg-s-message-list__event, .msg-s-event-listitem, li[class*="msg-s-message-list__event"]').length;

  await sleep(rand(2500, 4000)); // let earlier messages load
  if (history() > 0) { await closeBox(); return { outcome: 'already_messaged', detail: 'chat already has messages' }; }

  editor.focus();
  document.execCommand('selectAll', false);
  document.execCommand('delete', false);
  const parts = message.match(/[^.!?]+[.!?]*\s*/g) || [message];
  for (const part of parts) { document.execCommand('insertText', false, part); await sleep(rand(400, 1100)); }
  if (norm(editor.innerText) !== norm(message)) {
    // Fallback if execCommand was ignored in a background tab.
    editor.innerHTML = '';
    const para = document.createElement('p');
    para.textContent = message;
    editor.appendChild(para);
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: message }));
    await sleep(800);
  }
  if (norm(editor.innerText) !== norm(message)) { await closeBox(); return { outcome: 'error', detail: 'could not type the message' }; }

  await sleep(rand(1200, 2500));
  const send = await waitFor(() => {
    const b = box.querySelector('button.msg-form__send-button') || [...box.querySelectorAll('button')].find((x) => /^send$/.test(label(x)));
    return b && !b.disabled ? b : null;
  }, 5000);
  if (!send) {
    document.execCommand('selectAll', false); document.execCommand('delete', false);
    await closeBox();
    return { outcome: 'error', detail: 'send button not ready' };
  }
  send.click();
  const ok = await waitFor(() => history() > 0 && !norm(editor.innerText), 8000);
  await sleep(rand(1000, 2000));
  await closeBox();
  return ok ? { outcome: 'sent' } : { outcome: 'uncertain', detail: 'clicked send but could not confirm' };
}
