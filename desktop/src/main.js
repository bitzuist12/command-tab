'use strict';

// Tauri global (present only inside the app; absent in a plain browser preview).
const TAURI = window.__TAURI__;
const invoke = TAURI && TAURI.core ? TAURI.core.invoke : null;

const el = (id) => document.getElementById(id);
const cards = el('cards');
const statusLine = el('statusLine');

const SETTINGS_KEY = 'ctwa:settings';
const settings = Object.assign(
  // On-device by default: the summarizer runs locally (npm run on-device →
  // llama.cpp + a small model). Nothing leaves the machine. Clear it in
  // Settings to fall back to a hosted backend, or leave blank for raw digest.
  { bridgeUrl: 'http://127.0.0.1:8003', backendUrl: 'http://127.0.0.1:8090', token: '', days: 7 },
  readJSON(localStorage.getItem(SETTINGS_KEY)) || {}
);

function readJSON(s) { try { return JSON.parse(s); } catch { return null; } }
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// ─── action classification (mirrors the Hamilton structured schema) ──────────
function actionClass(st) {
  const state = String(st?.action_state || '').toLowerCase();
  const label = String(st?.action_label || '').toLowerCase();
  if (state.includes('reply_needed') || label.includes('reply needed') || (st && st.pending_from_you)) return 'reply';
  if (state.includes('review') || label.includes('review') || label.includes('maybe')) return 'review';
  return 'none';
}
const RANK = { reply: 0, review: 1, none: 2 };

// ─── rendering ───────────────────────────────────────────────────────────────
function messageRow(m) {
  const who = m.fromMe ? 'me' : (m.from || '');
  return `<div class="msg ${m.fromMe ? 'me' : ''}"><span class="who">${escapeHtml(who)}:</span>${escapeHtml(m.body || '')}</div>`;
}

function cardHtml(c) {
  const st = c.structured || null;
  const cls = st ? actionClass(st) : 'none';
  const label = st?.action_label || (c.summary ? 'Review' : 'Not summarized');
  const msgs = Array.isArray(c.messages) ? c.messages : [];
  return `
  <article class="card ${cls}">
    <div class="card-head">
      <span class="card-name">${escapeHtml(c.name || 'Chat')}</span>
      ${c.unread ? `<span class="unread">${escapeHtml(String(c.unread))}</span>` : ''}
    </div>
    <span class="badge ${cls}">${escapeHtml(label)}</span>
    ${c.summary ? `<div class="summary">${escapeHtml(c.summary)}</div>` : `<div class="unsum">Not summarized — set a backend URL in settings.</div>`}
    ${st?.pending_from_you ? `<div class="pending you"><b>Your move:</b> ${escapeHtml(st.pending_from_you)}</div>` : ''}
    ${st?.pending_from_them ? `<div class="pending them"><b>Waiting on them:</b> ${escapeHtml(st.pending_from_them)}</div>` : ''}
    ${Array.isArray(st?.top_topics) && st.top_topics.length ? `<div class="topics">${st.top_topics.slice(0, 5).map((t) => `<span class="chip">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
    ${st?.suggestion ? `<div class="suggestion">💡 ${escapeHtml(st.suggestion)}</div>` : ''}
    ${msgs.length ? `<details class="thread"><summary>${msgs.length} recent message${msgs.length === 1 ? '' : 's'}</summary><div class="msgs">${msgs.slice(-30).map(messageRow).join('')}</div></details>` : ''}
  </article>`;
}

function render(result) {
  const list = Array.isArray(result?.chats) ? result.chats.slice() : [];
  list.sort((a, b) => (RANK[a.structured ? actionClass(a.structured) : 'none'] - RANK[b.structured ? actionClass(b.structured) : 'none']) || ((b.unread || 0) - (a.unread || 0)));
  if (!list.length) { cards.innerHTML = ''; setEmpty('No chats in the selected window.'); return; }
  setEmpty(null);
  cards.innerHTML = list.map(cardHtml).join('');
}

function setEmpty(msg) {
  const e = el('empty');
  if (!msg) { e.hidden = true; return; }
  e.hidden = false; e.textContent = msg;
}
function setStatus(text, isError) {
  statusLine.innerHTML = isError ? `<span class="error">${escapeHtml(text)}</span>` : escapeHtml(text);
}

// ─── live pipeline ───────────────────────────────────────────────────────────
async function refresh() {
  if (!invoke) { setStatus('Preview mode — live data needs the app (npm run dev). Showing demo.', true); render(DEMO); return; }
  setStatus('Refreshing…');
  try {
    const result = await invoke('run_pipeline', {
      bridgeUrl: settings.bridgeUrl, backendUrl: settings.backendUrl,
      token: settings.token, days: Number(settings.days) || 7,
    });
    render(result);
    const n = (result?.chats || []).length;
    setStatus(result?.summarized ? `Live · summarized · ${n} chats · ${new Date().toLocaleTimeString()}`
      : `Live · raw digest (no backend) · ${n} chats · ${new Date().toLocaleTimeString()}`);
  } catch (e) {
    setStatus(String(e), true);
  }
}

// ─── settings panel ──────────────────────────────────────────────────────────
function syncInputs() {
  el('bridgeUrl').value = settings.bridgeUrl;
  el('backendUrl').value = settings.backendUrl;
  el('token').value = settings.token;
  el('days').value = settings.days;
}
el('btnSettings').onclick = () => { const s = el('settings'); s.hidden = !s.hidden; };
el('btnSaveSettings').onclick = () => {
  settings.bridgeUrl = el('bridgeUrl').value.trim() || 'http://127.0.0.1:8003';
  settings.backendUrl = el('backendUrl').value.trim();
  settings.token = el('token').value.trim();
  settings.days = Math.max(1, Math.min(30, Number(el('days').value) || 7));
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  el('settings').hidden = true;
  refresh();
};
el('btnRefresh').onclick = refresh;
el('btnDemo').onclick = () => { render(DEMO); setStatus(`Demo data · ${DEMO.chats.length} chats`); };

// ─── demo data (so you can SEE the UI without WhatsApp/backend) ───────────────
const DEMO = {
  summarized: true,
  generated: new Date().toISOString(),
  chats: [
    {
      id: 'demo-1', name: 'Hanh', unread: 3,
      summary: 'Hanh confirmed the Vietnam M&A list and is waiting for you to lock Friday dinner. She also shared two new target names.',
      structured: {
        action_state: 'reply_needed', action_label: 'Reply needed',
        pending_from_you: 'Confirm Friday 7pm dinner and reply with the two targets you like',
        pending_from_them: null,
        top_topics: ['dinner Friday', 'M&A targets', 'weekend'],
        suggestion: 'Say yes to 7pm and ask her to send the deck.',
        confidence: 0.82,
      },
      messages: [
        { fromMe: false, from: 'Hanh', body: 'Did you see the two new targets I sent?' },
        { fromMe: false, from: 'Hanh', body: 'Also are we still on for Friday dinner?' },
        { fromMe: true, from: 'me', body: 'Looking now, give me an hour' },
      ],
    },
    {
      id: 'demo-2', name: 'Mom', unread: 1,
      summary: 'Your mom asked which flight you are taking next week and whether she should cook.',
      structured: {
        action_state: 'reply_needed', action_label: 'Reply needed',
        pending_from_you: 'Tell her your flight time next week',
        pending_from_them: null,
        top_topics: ['flight', 'visit'],
        suggestion: 'Send the flight time; offer to call tonight.',
        confidence: 0.9,
      },
      messages: [{ fromMe: false, from: 'Mom', body: 'What time is your flight? Should I cook?' }],
    },
    {
      id: 'demo-3', name: 'Michael Mignano', unread: 0,
      summary: 'You sent the port-project memo. Michael said he would review and revert by Thursday — ball is in his court.',
      structured: {
        action_state: 'review_or_reply', action_label: 'Waiting on them',
        pending_from_you: null,
        pending_from_them: 'Michael to send feedback on the memo by Thursday',
        top_topics: ['port project', 'memo'],
        suggestion: 'No action now; nudge Friday if silent.',
        confidence: 0.74,
      },
      messages: [
        { fromMe: true, from: 'me', body: 'Sent the memo — keen on your read' },
        { fromMe: false, from: 'Michael Mignano', body: 'Thanks, will revert by Thu' },
      ],
    },
    {
      id: 'demo-4', name: 'Edanur (Maslow)', unread: 0,
      summary: 'Routine check-in about the ideation merge. Nothing pending; last message was a thumbs up.',
      structured: {
        action_state: 'no_action', action_label: 'No action',
        pending_from_you: null, pending_from_them: null,
        top_topics: ['ideation', 'status'],
        suggestion: '', confidence: 0.6,
      },
      messages: [{ fromMe: false, from: 'Edanur', body: '👍 merged, all good' }],
    },
  ],
};

// ─── boot ────────────────────────────────────────────────────────────────────
syncInputs();
render(DEMO);
setStatus(invoke ? 'Ready · showing demo. Click Refresh for live.' : 'Preview · showing demo data.');
