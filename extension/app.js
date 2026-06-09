/* ================================================================
   Command Tab — Dashboard App

   This file is the brain of the dashboard. Now that the dashboard
   IS the extension page (not inside an iframe), it can call
   chrome.tabs and chrome.storage directly — no postMessage bridge needed.

   What this file does:
   1. Reads open browser tabs directly via chrome.tabs.query()
   2. Groups tabs by domain with a landing pages category
   3. Renders domain cards, banners, and stats
   4. Handles all user actions (close tabs, save for later, focus tab)
   5. Stores "Saved for Later" tabs in chrome.storage.local (no server)
   ================================================================ */

'use strict';


/* ----------------------------------------------------------------
   CHROME TABS — Direct API Access

   Since this page IS the extension's new tab page, it has full
   access to chrome.tabs and chrome.storage. No middleman needed.
   ---------------------------------------------------------------- */

// All open tabs — populated by fetchOpenTabs()
let openTabs = [];

const DEFAULT_CONNECTOR_URL = 'http://127.0.0.1:8733';
const CONNECTOR_URL_STORAGE_KEY = 'command-tab:connector-url';
const CODEX_PATH_STORAGE_KEY = 'command-tab:codex-path';
const REVIEW_SORT_STORAGE_KEY = 'command-tab:review-sort';
const HIDDEN_CONNECTORS_STORAGE_KEY = 'command-tab:hidden-connectors';

function connectorBaseUrl() {
  return (localStorage.getItem(CONNECTOR_URL_STORAGE_KEY) || window.COMMAND_TAB_CONNECTOR_URL || DEFAULT_CONNECTOR_URL).replace(/\/$/, '');
}

// Per-connector visibility. A connector id in this set is hidden from the grid.
function getHiddenConnectors() {
  try {
    const raw = JSON.parse(localStorage.getItem(HIDDEN_CONNECTORS_STORAGE_KEY) || '[]');
    return new Set(Array.isArray(raw) ? raw.map(String) : []);
  } catch (_error) {
    return new Set();
  }
}

function isConnectorHidden(id) {
  return getHiddenConnectors().has(String(id));
}

function setHiddenConnectors(set) {
  localStorage.setItem(HIDDEN_CONNECTORS_STORAGE_KEY, JSON.stringify([...set]));
}

/**
 * fetchOpenTabs()
 *
 * Reads all currently open browser tabs directly from Chrome.
 * Sets the extensionId flag so we can identify Command Tab's own pages.
 */
async function fetchOpenTabs() {
  try {
    const extensionId = chrome.runtime.id;
    // The new URL for this page is now index.html (not newtab.html)
    const newtabUrl = `chrome-extension://${extensionId}/index.html`;

    const tabs = await chrome.tabs.query({});
    openTabs = tabs.map(t => ({
      id:       t.id,
      url:      t.url,
      title:    t.title,
      windowId: t.windowId,
      active:   t.active,
      // Flag Command Tab's own pages so we can detect duplicate new tabs
      isTabOut: t.url === newtabUrl || t.url === 'chrome://newtab/',
    }));
  } catch {
    // chrome.tabs API unavailable (shouldn't happen in an extension page)
    openTabs = [];
  }
}

/**
 * closeTabsByUrls(urls)
 *
 * Closes all open tabs whose hostname matches any of the given URLs.
 * After closing, re-fetches the tab list to keep our state accurate.
 *
 * Special case: file:// URLs are matched exactly (they have no hostname).
 */
async function closeTabsByUrls(urls) {
  if (!urls || urls.length === 0) return;

  // Separate file:// URLs (exact match) from regular URLs (hostname match)
  const targetHostnames = [];
  const exactUrls = new Set();

  for (const u of urls) {
    if (u.startsWith('file://')) {
      exactUrls.add(u);
    } else {
      try { targetHostnames.push(new URL(u).hostname); }
      catch { /* skip unparseable */ }
    }
  }

  const allTabs = await chrome.tabs.query({});
  const toClose = allTabs
    .filter(tab => {
      const tabUrl = tab.url || '';
      if (tabUrl.startsWith('file://') && exactUrls.has(tabUrl)) return true;
      try {
        const tabHostname = new URL(tabUrl).hostname;
        return tabHostname && targetHostnames.includes(tabHostname);
      } catch { return false; }
    })
    .map(tab => tab.id);

  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * closeTabsExact(urls)
 *
 * Closes tabs by exact URL match (not hostname). Used for landing pages
 * so closing "Gmail inbox" doesn't also close individual email threads.
 */
async function closeTabsExact(urls) {
  if (!urls || urls.length === 0) return;
  const urlSet = new Set(urls);
  const allTabs = await chrome.tabs.query({});
  const toClose = allTabs.filter(t => urlSet.has(t.url)).map(t => t.id);
  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * focusTab(url)
 *
 * Switches Chrome to the tab with the given URL (exact match first,
 * then hostname fallback). Also brings the window to the front.
 */
async function focusTab(url) {
  if (!url) return;
  const allTabs = await chrome.tabs.query({});
  const currentWindow = await chrome.windows.getCurrent();

  // Try exact URL match first
  let matches = allTabs.filter(t => t.url === url);

  // Fall back to hostname match
  if (matches.length === 0) {
    try {
      const targetHost = new URL(url).hostname;
      matches = allTabs.filter(t => {
        try { return new URL(t.url).hostname === targetHost; }
        catch { return false; }
      });
    } catch {}
  }

  if (matches.length === 0) return;

  // Prefer a match in a different window so it actually switches windows
  const match = matches.find(t => t.windowId !== currentWindow.id) || matches[0];
  await chrome.tabs.update(match.id, { active: true });
  await chrome.windows.update(match.windowId, { focused: true });
}

/**
 * closeDuplicateTabs(urls, keepOne)
 *
 * Closes duplicate tabs for the given list of URLs.
 * keepOne=true → keep one copy of each, close the rest.
 * keepOne=false → close all copies.
 */
async function closeDuplicateTabs(urls, keepOne = true) {
  const allTabs = await chrome.tabs.query({});
  const toClose = [];

  for (const url of urls) {
    const matching = allTabs.filter(t => t.url === url);
    if (keepOne) {
      const keep = matching.find(t => t.active) || matching[0];
      for (const tab of matching) {
        if (tab.id !== keep.id) toClose.push(tab.id);
      }
    } else {
      for (const tab of matching) toClose.push(tab.id);
    }
  }

  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * closeTabOutDupes()
 *
 * Closes all duplicate Command Tab new-tab pages except the current one.
 */
async function closeTabOutDupes() {
  const extensionId = chrome.runtime.id;
  const newtabUrl = `chrome-extension://${extensionId}/index.html`;

  const allTabs = await chrome.tabs.query({});
  const currentWindow = await chrome.windows.getCurrent();
  const tabOutTabs = allTabs.filter(t =>
    t.url === newtabUrl || t.url === 'chrome://newtab/'
  );

  if (tabOutTabs.length <= 1) return;

  // Keep the active Command Tab tab in the CURRENT window — that's the one the
  // user is looking at right now. Falls back to any active one, then the first.
  const keep =
    tabOutTabs.find(t => t.active && t.windowId === currentWindow.id) ||
    tabOutTabs.find(t => t.active) ||
    tabOutTabs[0];
  const toClose = tabOutTabs.filter(t => t.id !== keep.id).map(t => t.id);
  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}


/* ----------------------------------------------------------------
   SAVED FOR LATER — chrome.storage.local

   Replaces the old server-side SQLite + REST API with Chrome's
   built-in key-value storage. Data persists across browser sessions
   and doesn't require a running server.

   Data shape stored under the "deferred" key:
   [
     {
       id: "1712345678901",          // timestamp-based unique ID
       url: "https://example.com",
       title: "Example Page",
       savedAt: "2026-04-04T10:00:00.000Z",  // ISO date string
       completed: false,             // true = checked off (archived)
       dismissed: false              // true = dismissed without reading
     },
     ...
   ]
   ---------------------------------------------------------------- */

/**
 * saveTabForLater(tab)
 *
 * Saves a single tab to the "Saved for Later" list in chrome.storage.local.
 * @param {{ url: string, title: string }} tab
 */
async function saveTabForLater(tab) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  deferred.push({
    id:        Date.now().toString(),
    url:       tab.url,
    title:     tab.title,
    savedAt:   new Date().toISOString(),
    completed: false,
    dismissed: false,
  });
  await chrome.storage.local.set({ deferred });
}

/**
 * getSavedTabs()
 *
 * Returns all saved tabs from chrome.storage.local.
 * Filters out dismissed items (those are gone for good).
 * Splits into active (not completed) and archived (completed).
 */
async function getSavedTabs() {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const visible = deferred.filter(t => !t.dismissed);
  return {
    active:   visible.filter(t => !t.completed),
    archived: visible.filter(t => t.completed),
  };
}

/**
 * checkOffSavedTab(id)
 *
 * Marks a saved tab as completed (checked off). It moves to the archive.
 */
async function checkOffSavedTab(id) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const tab = deferred.find(t => t.id === id);
  if (tab) {
    tab.completed = true;
    tab.completedAt = new Date().toISOString();
    await chrome.storage.local.set({ deferred });
  }
}

/**
 * dismissSavedTab(id)
 *
 * Marks a saved tab as dismissed (removed from all lists).
 */
async function dismissSavedTab(id) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const tab = deferred.find(t => t.id === id);
  if (tab) {
    tab.dismissed = true;
    await chrome.storage.local.set({ deferred });
  }
}


/* ----------------------------------------------------------------
   UI HELPERS
   ---------------------------------------------------------------- */

/**
 * playCloseSound()
 *
 * Plays a clean "swoosh" sound when tabs are closed.
 * Built entirely with the Web Audio API — no sound files needed.
 * A filtered noise sweep that descends in pitch, like air moving.
 */
function playCloseSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const t = ctx.currentTime;

    // Swoosh: shaped white noise through a sweeping bandpass filter
    const duration = 0.25;
    const buffer = ctx.createBuffer(1, ctx.sampleRate * duration, ctx.sampleRate);
    const data = buffer.getChannelData(0);

    // Generate noise with a natural envelope (quick attack, smooth decay)
    for (let i = 0; i < data.length; i++) {
      const pos = i / data.length;
      // Envelope: ramps up fast in first 10%, then fades out smoothly
      const env = pos < 0.1 ? pos / 0.1 : Math.pow(1 - (pos - 0.1) / 0.9, 1.5);
      data[i] = (Math.random() * 2 - 1) * env;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    // Bandpass filter sweeps from high to low — creates the "swoosh" character
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 2.0;
    filter.frequency.setValueAtTime(4000, t);
    filter.frequency.exponentialRampToValueAtTime(400, t + duration);

    // Volume
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.15, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);

    source.connect(filter).connect(gain).connect(ctx.destination);
    source.start(t);

    setTimeout(() => ctx.close(), 500);
  } catch {
    // Audio not supported — fail silently
  }
}

/**
 * shootConfetti(x, y)
 *
 * Shoots a burst of colorful confetti particles from the given screen
 * coordinates (typically the center of a card being closed).
 * Pure CSS + JS, no libraries.
 */
function shootConfetti(x, y) {
  const colors = [
    '#c8713a', // amber
    '#e8a070', // amber light
    '#5a7a62', // sage
    '#8aaa92', // sage light
    '#5a6b7a', // slate
    '#8a9baa', // slate light
    '#d4b896', // warm paper
    '#b35a5a', // rose
  ];

  const particleCount = 17;

  for (let i = 0; i < particleCount; i++) {
    const el = document.createElement('div');

    const isCircle = Math.random() > 0.5;
    const size = 5 + Math.random() * 6; // 5–11px
    const color = colors[Math.floor(Math.random() * colors.length)];

    el.style.cssText = `
      position: fixed;
      left: ${x}px;
      top: ${y}px;
      width: ${size}px;
      height: ${size}px;
      background: ${color};
      border-radius: ${isCircle ? '50%' : '2px'};
      pointer-events: none;
      z-index: 9999;
      transform: translate(-50%, -50%);
      opacity: 1;
    `;
    document.body.appendChild(el);

    // Physics: random angle and speed for the outward burst
    const angle   = Math.random() * Math.PI * 2;
    const speed   = 60 + Math.random() * 120;
    const vx      = Math.cos(angle) * speed;
    const vy      = Math.sin(angle) * speed - 80; // bias upward
    const gravity = 200;

    const startTime = performance.now();
    const duration  = 700 + Math.random() * 200; // 700–900ms

    function frame(now) {
      const elapsed  = (now - startTime) / 1000;
      const progress = elapsed / (duration / 1000);

      if (progress >= 1) { el.remove(); return; }

      const px = vx * elapsed;
      const py = vy * elapsed + 0.5 * gravity * elapsed * elapsed;
      const opacity = progress < 0.5 ? 1 : 1 - (progress - 0.5) * 2;
      const rotate  = elapsed * 200 * (isCircle ? 0 : 1);

      el.style.transform = `translate(calc(-50% + ${px}px), calc(-50% + ${py}px)) rotate(${rotate}deg)`;
      el.style.opacity = opacity;

      requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
  }
}

/**
 * animateCardOut(card)
 *
 * Smoothly removes a mission card: fade + scale down, then confetti.
 * After the animation, checks if the grid is now empty.
 */
function animateCardOut(card) {
  if (!card) return;

  const rect = card.getBoundingClientRect();
  shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);

  card.classList.add('closing');
  setTimeout(() => {
    card.remove();
    checkAndShowEmptyState();
  }, 300);
}

/**
 * showToast(message)
 *
 * Brief pop-up notification at the bottom of the screen.
 */
function showToast(message) {
  const toast = document.getElementById('toast');
  document.getElementById('toastText').textContent = message;
  toast.classList.add('visible');
  setTimeout(() => toast.classList.remove('visible'), 2500);
}

/* ----------------------------------------------------------------
   COMMAND CENTER CONNECTORS

   Optional local/server API inspired by the Hamilton prototype.
   The extension stays useful without it. If the connector server is
   offline, show a clear offline state instead of sample/fallback data.
   ---------------------------------------------------------------- */

async function fetchCommandSummary() {
  const endpoint = `${connectorBaseUrl()}/api/summary`;
  try {
    const res = await fetch(endpoint, { cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        status: 'error',
        source: 'live',
        generated_at: new Date().toISOString(),
        error: data.error || `${endpoint} returned ${res.status}`,
        connectors: [],
      };
    }
    return data;
  } catch (error) {
    return {
      status: 'disconnected',
      source: 'none',
      generated_at: new Date().toISOString(),
      error: `Connector server unreachable at ${endpoint}: ${error.message || error}`,
      connectors: [],
    };
  }
}

async function postBackendAction(path, body = {}) {
  const endpoint = `${connectorBaseUrl()}${path}`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    throw new Error(data.error || `${path} returned ${res.status}`);
  }
  return data;
}

function taskActionPayload(actionEl, extra = {}) {
  const payload = { ...extra };
  const line = actionEl.dataset.line;
  if (line !== undefined && line !== '') payload.line = Number(line);
  const id = actionEl.dataset.id;
  if (id !== undefined && id !== '') payload.id = id;
  const noteId = actionEl.dataset.noteId;
  if (noteId) payload.note_id = noteId;
  return payload;
}

function relativeDate(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function openTaskNoteDialog(actionEl) {
  document.getElementById('commandTaskNoteModal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'commandTaskNoteModal';
  modal.className = 'command-modal';
  modal.innerHTML = `
    <div class="command-modal-card">
      <div class="command-modal-head">
        <div>
          <div class="command-kicker">Task note</div>
          <strong>${escapeHtml(actionEl.dataset.title || 'Task')}</strong>
        </div>
        <button class="command-modal-close" data-action="command-task-note-close" type="button">×</button>
      </div>
      <textarea class="command-modal-text" data-role="command-task-note-text" placeholder="Add context, decision, link, or next thought..."></textarea>
      <div class="command-modal-actions">
        <span class="command-modal-status" data-role="command-task-note-status"></span>
        <button class="command-action" data-action="command-task-note-save" data-line="${escapeHtml(actionEl.dataset.line || '')}" data-id="${escapeHtml(actionEl.dataset.id || '')}" data-note-id="${escapeHtml(actionEl.dataset.noteId || '')}" type="button">Save note</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.querySelector('[data-role="command-task-note-text"]')?.focus();
}

function openTaskWhatsAppDialog(actionEl) {
  document.getElementById('commandTaskWhatsAppModal')?.remove();
  const title = actionEl.dataset.title || 'Task';
  const detail = actionEl.dataset.detail || '';
  const draft = `Quick follow-up on this:\n\n${title}${detail ? `\n\nContext: ${detail}` : ''}`;
  const modal = document.createElement('div');
  modal.id = 'commandTaskWhatsAppModal';
  modal.className = 'command-modal';
  modal.innerHTML = `
    <div class="command-modal-card">
      <div class="command-modal-head">
        <div>
          <div class="command-kicker">Task to WhatsApp</div>
          <strong>${escapeHtml(title)}</strong>
        </div>
        <button class="command-modal-close" data-action="command-task-wa-close" type="button">×</button>
      </div>
      <input class="command-task-input" data-role="command-task-wa-chat" placeholder="WhatsApp chat id or exact name" autocomplete="off">
      <textarea class="command-modal-text" data-role="command-task-wa-text">${escapeHtml(draft)}</textarea>
      <div class="command-modal-actions">
        <span class="command-modal-status" data-role="command-task-wa-status">Manual send. Bridge preflight runs before sending.</span>
        <button class="command-action" data-action="command-task-wa-send" type="button">Send WhatsApp</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.querySelector('[data-role="command-task-wa-chat"]')?.focus();
}

function collectHabitMetrics(actionEl) {
  const row = actionEl.closest('[data-habit-id]');
  const metrics = {};
  row?.querySelectorAll('[data-role="command-habit-metric"]').forEach(input => {
    const id = input.dataset.metricId || '';
    const value = input.value.trim();
    if (id && value) metrics[id] = Number.isNaN(Number(value)) ? value : Number(value);
  });
  return Object.keys(metrics).length ? metrics : null;
}

function reviewStorageKey(connectorId, itemId, action) {
  return `command-tab:${connectorId}:${action}:${itemId}`;
}

function isReviewHidden(connectorId, item) {
  const id = item.id || item.title || '';
  if (!id) return false;
  return localStorage.getItem(reviewStorageKey(connectorId, id, 'reviewed'))
    || localStorage.getItem(reviewStorageKey(connectorId, id, 'later'))
    || (connectorId === 'gmail' && item.sender && localStorage.getItem(reviewStorageKey(connectorId, item.sender, 'blocked')));
}

function setReviewState(connectorId, itemId, action) {
  localStorage.setItem(reviewStorageKey(connectorId, itemId, action), new Date().toISOString());
}

function reviewSortKey(connectorId) {
  return `${REVIEW_SORT_STORAGE_KEY}:${connectorId}`;
}

function sortReviewItems(connectorId, items) {
  const mode = localStorage.getItem(reviewSortKey(connectorId)) || 'needs';
  const copy = [...items];
  if (mode === 'name') {
    copy.sort((a, b) => String(a.title || a.sender || '').localeCompare(String(b.title || b.sender || '')));
  } else if (mode === 'recent') {
    copy.sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0));
  } else {
    copy.sort((a, b) => {
      const aNeed = Number(a.unread || 0) + (a.body ? 1 : 0);
      const bNeed = Number(b.unread || 0) + (b.body ? 1 : 0);
      return bNeed - aNeed || Number(b.timestamp || 0) - Number(a.timestamp || 0);
    });
  }
  return copy;
}

function connectorStatusLabel(status) {
  if (status === 'ok') return 'Live';
  if (status === 'cached') return 'Cached';
  if (status === 'disconnected') return 'Disconnected';
  if (status === 'template') return 'Template';
  return 'Error';
}

function renderConnectorActions(connector) {
  const actions = Array.isArray(connector.actions) ? connector.actions : [];
  if (!actions.length) return '';
  return `
    <div class="command-actions">
      ${actions.slice(0, 3).map(action => {
        if (action.url) {
          return `<a class="command-action" href="${escapeHtml(action.url)}" target="_blank" rel="noopener">${escapeHtml(action.label || 'Open')}</a>`;
        }
        return `<button class="command-action" data-action="${escapeHtml(action.command || 'refresh-command-center')}" type="button">${escapeHtml(action.label || 'Run')}</button>`;
      }).join('')}
    </div>`;
}

function renderWhatsAppPlanRows(connector) {
  const planned = Array.isArray(connector.planned) ? connector.planned : [];
  if (!planned.length) return '';
  const canSend = connector.status === 'ok';
  return `
    <div class="command-plan">
      <div class="command-plan-title">Planned messages</div>
      ${planned.slice(0, 4).map(item => `
        <div class="command-plan-row ${item.enabled === false ? 'is-disabled' : ''}">
          <div>
            <span>${escapeHtml(item.title || 'WhatsApp chat')}</span>
            <small>${escapeHtml(item.detail || '')}</small>
          </div>
          <textarea class="command-plan-message" data-role="whatsapp-plan-message" data-plan-id="${escapeHtml(item.id || '')}" ${item.enabled === false ? 'disabled' : ''}>${escapeHtml(item.message || '')}</textarea>
          <button class="command-action compact" data-action="whatsapp-plan-send" data-plan-id="${escapeHtml(item.id || '')}" type="button" ${canSend && item.enabled !== false ? '' : 'disabled'}>Send</button>
        </div>
      `).join('')}
    </div>`;
}

function renderTaskConnectorCard(connector) {
  const status = connector.status || 'error';
  const items = Array.isArray(connector.items) ? connector.items : [];
  const focus = connector.focus || null;
  const nudges = Array.isArray(connector.nudges) ? connector.nudges : [];
  const renderTaskActions = item => `
    <span class="command-task-actions">
      <button class="command-task-mini ${item.pinned ? 'is-active' : ''}" data-action="command-task-pin" data-line="${escapeHtml(item.line ?? '')}" data-id="${escapeHtml(item.id ?? '')}" data-pinned="${item.pinned ? 'true' : 'false'}" type="button" title="${item.pinned ? 'Unpin' : 'Pin'}">Pin</button>
      <button class="command-task-mini" data-action="command-task-remind" data-line="${escapeHtml(item.line ?? '')}" data-id="${escapeHtml(item.id ?? '')}" type="button">Remind</button>
      <button class="command-task-mini" data-action="command-task-release" data-line="${escapeHtml(item.line ?? '')}" data-id="${escapeHtml(item.id ?? '')}" type="button">Later</button>
      <button class="command-task-mini" data-action="command-task-note-open" data-line="${escapeHtml(item.line ?? '')}" data-id="${escapeHtml(item.id ?? '')}" data-note-id="${escapeHtml(item.note_id || '')}" data-title="${escapeHtml(item.title || item.label || 'Task')}" type="button">Note</button>
      <button class="command-task-mini" data-action="command-task-wa-open" data-title="${escapeHtml(item.title || item.label || 'Task')}" data-detail="${escapeHtml(item.detail || '')}" type="button">WA</button>
      <button class="command-task-mini" data-action="command-task-agent" data-line="${escapeHtml(item.line ?? '')}" data-id="${escapeHtml(item.id ?? '')}" type="button">Agent</button>
    </span>`;
  const focusHtml = focus ? `
    <div class="command-focus-task">
      <div class="command-kicker">Must finish today</div>
      <div class="command-focus-main">
        <button class="command-task-check" data-action="command-task-check" data-line="${escapeHtml(focus.line ?? '')}" data-id="${escapeHtml(focus.id ?? '')}" data-checked="${focus.checked ? 'true' : 'false'}" type="button">${focus.checked ? '✓' : ''}</button>
        <div class="command-task-copy">
          <span>${escapeHtml(focus.title || 'Focus task')}</span>
          <small>${escapeHtml(focus.detail || '')}</small>
        </div>
      </div>
      ${renderTaskActions(focus)}
    </div>` : '';
  const nudgeHtml = nudges.length ? `
    <div class="command-nudges">
      <div class="command-plan-title">Today’s nudges</div>
      ${nudges.slice(0, 4).map(item => `
        <div class="command-task-row compact">
          <button class="command-task-check" data-action="command-task-check" data-line="${escapeHtml(item.line ?? '')}" data-id="${escapeHtml(item.id ?? '')}" data-checked="${item.checked ? 'true' : 'false'}" type="button">${item.checked ? '✓' : ''}</button>
          <span class="command-task-copy">
            <span>${escapeHtml(item.title || 'Nudge')}</span>
            <small>${escapeHtml(item.detail || '')}</small>
          </span>
          ${renderTaskActions(item)}
        </div>`).join('')}
    </div>` : '';
  const itemRows = items.slice(0, 6).map(item => `
    <div class="command-task-row" data-task-line="${escapeHtml(item.line ?? '')}" data-task-id="${escapeHtml(item.id ?? '')}" data-note-id="${escapeHtml(item.note_id || '')}">
      <button class="command-task-check" data-action="command-task-check" data-line="${escapeHtml(item.line ?? '')}" data-id="${escapeHtml(item.id ?? '')}" data-checked="${item.checked ? 'true' : 'false'}" type="button" title="${item.checked ? 'Mark open' : 'Mark done'}">${item.checked ? '✓' : ''}</button>
      <span class="command-task-copy">
        <span>${escapeHtml(item.title || item.label || 'Task')}</span>
        <small>${escapeHtml(item.detail || '')}</small>
      </span>
      ${renderTaskActions(item)}
    </div>
  `).join('');
  return `
    <article class="command-card command-task-card is-${escapeHtml(status)}">
      <div class="command-card-head">
        <div>
          <div class="command-kicker">${escapeHtml(connector.kind || 'tasks')}</div>
          <h3>${escapeHtml(connector.label || 'Tasks')}</h3>
        </div>
        <span class="command-status">${escapeHtml(connectorStatusLabel(status))}</span>
      </div>
      ${connector.summary ? `<div class="command-summary">${escapeHtml(connector.summary)}</div>` : ''}
      ${connector.error ? `<div class="command-error">${escapeHtml(connector.error)}</div>` : ''}
      ${focusHtml}
      ${nudgeHtml}
      <form class="command-task-form" data-action="command-task-add">
        <input class="command-task-input" data-role="command-task-title" placeholder="Add a task..." autocomplete="off">
        <input class="command-task-input detail" data-role="command-task-detail" placeholder="Detail" autocomplete="off">
        <button class="command-action" type="submit">Add</button>
      </form>
      ${itemRows ? `<div class="command-items command-task-list">${itemRows}</div>` : '<div class="command-empty">No live tasks.</div>'}
      ${renderConnectorActions(connector)}
    </article>
  `;
}

function renderReviewConnectorCard(connector) {
  const status = connector.status || 'error';
  const sortMode = localStorage.getItem(reviewSortKey(connector.id)) || 'needs';
  const items = sortReviewItems(connector.id, (Array.isArray(connector.items) ? connector.items : []).filter(item => !isReviewHidden(connector.id, item)));
  const rows = items.slice(0, 8).map(item => {
    const id = item.id || item.title || '';
    return `
      <div class="command-review-row" data-review-id="${escapeHtml(id)}" data-review-connector="${escapeHtml(connector.id)}" data-review-search="${escapeHtml(`${item.title || ''} ${item.detail || ''} ${item.body || ''} ${item.sender || ''}`.toLowerCase())}">
        <div class="command-review-copy">
          <span>${escapeHtml(item.title || 'Review item')}</span>
          <small>${escapeHtml(item.detail || item.sender || '')}</small>
          ${item.body ? `<p>${escapeHtml(item.body)}</p>` : ''}
        </div>
        <div class="command-review-actions">
          <button class="command-task-mini" data-action="command-review-toggle-detail" type="button">Details</button>
          <button class="command-task-mini" data-action="command-review-state" data-review-connector="${escapeHtml(connector.id)}" data-review-id="${escapeHtml(id)}" data-review-state="reviewed" type="button">Reviewed</button>
          <button class="command-task-mini" data-action="command-review-state" data-review-connector="${escapeHtml(connector.id)}" data-review-id="${escapeHtml(id)}" data-review-state="later" type="button">Later</button>
          ${connector.id === 'gmail' && item.sender ? `<button class="command-task-mini" data-action="command-review-state" data-review-connector="gmail" data-review-id="${escapeHtml(item.sender)}" data-review-state="blocked" type="button">Block sender</button>` : ''}
          ${connector.id === 'gmail' && item.body ? `<button class="command-task-mini" data-action="command-review-copy" data-copy-text="${escapeHtml(item.body)}" type="button">Copy</button>` : ''}
          ${connector.id === 'gmail' ? `<button class="command-task-mini" data-action="command-review-task" data-title="${escapeHtml(item.title || 'Email follow-up')}" data-detail="${escapeHtml(item.detail || item.body || '')}" type="button">Task</button>` : ''}
        </div>
        <div class="command-review-detail" hidden>
          <div class="command-plan-title">Thread detail</div>
          <p>${escapeHtml(item.body || item.detail || 'No extra detail available.')}</p>
          ${item.sender ? `<small>From: ${escapeHtml(item.sender)}</small>` : ''}
          ${item.timestamp ? `<small>Time: ${escapeHtml(String(item.timestamp))}</small>` : ''}
        </div>
      </div>`;
  }).join('');
  return `
    <article class="command-card command-review-card is-${escapeHtml(status)}" data-review-card="${escapeHtml(connector.id)}">
      <div class="command-card-head">
        <div>
          <div class="command-kicker">${escapeHtml(connector.kind || connector.id || 'review')}</div>
          <h3>${escapeHtml(connector.label || connector.id || 'Review')}</h3>
        </div>
        <span class="command-status">${escapeHtml(connectorStatusLabel(status))}</span>
      </div>
      ${connector.summary ? `<div class="command-summary">${escapeHtml(connector.summary)}</div>` : ''}
      ${connector.error ? `<div class="command-error">${escapeHtml(connector.error)}</div>` : ''}
      <div class="command-review-tools">
        <input class="command-review-search" data-role="command-review-search" placeholder="Search ${escapeHtml(connector.label || 'review')}" autocomplete="off">
        <select class="command-review-sort" data-action="command-review-sort" data-review-connector="${escapeHtml(connector.id)}">
          <option value="needs" ${sortMode === 'needs' ? 'selected' : ''}>Needs</option>
          <option value="recent" ${sortMode === 'recent' ? 'selected' : ''}>Recent</option>
          <option value="name" ${sortMode === 'name' ? 'selected' : ''}>Name</option>
        </select>
      </div>
      <div class="command-review-list">${rows || '<div class="command-empty">No visible review items.</div>'}</div>
      ${connector.id === 'whatsapp' ? renderWhatsAppPlanRows(connector) : ''}
      ${renderConnectorActions(connector)}
    </article>`;
}

function renderDailySystemsCard(connector) {
  const status = connector.status || 'error';
  const items = Array.isArray(connector.items) ? connector.items : [];
  const habitRows = items.filter(item => item.type === 'habit').map(item => `
    <div class="command-daily-row" data-habit-id="${escapeHtml(item.id || '')}">
      <button class="command-task-check" data-action="command-habit-check" data-habit-id="${escapeHtml(item.id || '')}" data-checked="${item.checked ? 'true' : 'false'}" type="button">${item.checked ? '✓' : ''}</button>
      <div class="command-task-copy">
        <span>${escapeHtml(item.title || 'Habit')}</span>
        <small>${escapeHtml(item.detail || (item.checked ? 'done' : 'open'))}</small>
        ${Array.isArray(item.metrics) && item.metrics.length ? `<div class="command-habit-metrics">
          ${item.metrics.map(metric => `
            <label>
              <span>${escapeHtml(metric.label || metric.id || 'Metric')}</span>
              <input class="command-metric-input" data-role="command-habit-metric" data-metric-id="${escapeHtml(metric.id || '')}" placeholder="${escapeHtml(metric.unit || '')}" inputmode="decimal">
            </label>`).join('')}
        </div>
        <button class="command-task-mini" data-action="command-habit-metrics-save" data-habit-id="${escapeHtml(item.id || '')}" type="button">Save metrics</button>` : ''}
      </div>
    </div>`).join('');
  const otherRows = items.filter(item => item.type !== 'habit').slice(0, 8).map(item => {
    if (item.type === 'voice') {
      return `<div class="command-item">
        <span>${escapeHtml(item.title || 'Voice notes')}</span>
        <small>${escapeHtml(item.detail || '')}</small>
        <div class="command-actions compact-row">
          <button class="command-task-mini" data-action="command-voice-play" data-text="${escapeHtml(item.detail || '')}" type="button">Play latest</button>
          <button class="command-task-mini" data-action="command-voice-open" type="button">Open app</button>
          <button class="command-task-mini" data-action="command-voice-folder" type="button">Folder</button>
        </div>
      </div>`;
    }
    if (item.type === 'vietnamese') {
      return `<div class="command-item">
        <span>${escapeHtml(item.title || 'Vietnamese')}</span>
        <small>${escapeHtml(item.detail || '')}</small>
        <div class="command-actions compact-row">
          <button class="command-task-mini ${item.studied_today ? 'is-active' : ''}" data-action="command-vietnamese-study" type="button">${item.studied_today ? 'Studied' : 'Mark studied'}</button>
        </div>
      </div>`;
    }
    if (item.type === 'gratitude') {
      return `<div class="command-item">
        <span>${escapeHtml(item.title || 'Gratitude')}</span>
        <small>${escapeHtml(item.detail || '')}</small>
        <form class="command-gratitude-form" data-action="command-gratitude-save">
          <input class="command-task-input" data-role="command-gratitude-text" placeholder="One thing worth noticing..." autocomplete="off">
          <button class="command-task-mini" type="submit">Save</button>
        </form>
      </div>`;
    }
    if (item.type === 'daily-shot') {
      return `<div class="command-item">
        <span>${escapeHtml(item.title || 'Daily shot')}</span>
        <small>${escapeHtml(item.detail || '')}</small>
        <form class="command-gratitude-form" data-action="command-daily-shot-save">
          <input class="command-task-input" data-role="command-daily-shot-text" placeholder="Who is today’s shot?" autocomplete="off">
          <button class="command-task-mini" type="submit">Save</button>
        </form>
      </div>`;
    }
    return `<div class="command-item">
      <span>${escapeHtml(item.title || 'Daily item')}</span>
      <small>${escapeHtml(item.detail || '')}</small>
    </div>`;
  }).join('');
  return `
    <article class="command-card command-daily-card is-${escapeHtml(status)}">
      <div class="command-card-head">
        <div>
          <div class="command-kicker">${escapeHtml(connector.kind || 'systems')}</div>
          <h3>${escapeHtml(connector.label || 'Daily Systems')}</h3>
        </div>
        <span class="command-status">${escapeHtml(connectorStatusLabel(status))}</span>
      </div>
      ${connector.summary ? `<div class="command-summary">${escapeHtml(connector.summary)}</div>` : ''}
      ${connector.error ? `<div class="command-error">${escapeHtml(connector.error)}</div>` : ''}
      <div class="command-daily-list">${habitRows || '<div class="command-empty">No habits loaded.</div>'}</div>
      ${otherRows ? `<div class="command-items">${otherRows}</div>` : ''}
      ${renderConnectorActions(connector)}
    </article>`;
}

function renderCalendarCard(connector) {
  const status = connector.status || 'error';
  const events = Array.isArray(connector.items) ? connector.items : [];
  const rows = events.slice(0, 8).map(event => `
    <div class="command-calendar-row">
      <div>
        <span>${escapeHtml(event.title || 'Event')}</span>
        <small>${escapeHtml(event.detail || '')}</small>
      </div>
    </div>`).join('');
  return `
    <article class="command-card command-calendar-card is-${escapeHtml(status)}">
      <div class="command-card-head">
        <div>
          <div class="command-kicker">${escapeHtml(connector.kind || 'calendar')}</div>
          <h3>${escapeHtml(connector.label || 'Calendar')}</h3>
        </div>
        <span class="command-status">${escapeHtml(connectorStatusLabel(status))}</span>
      </div>
      ${connector.summary ? `<div class="command-summary">${escapeHtml(connector.summary)}</div>` : ''}
      ${connector.error ? `<div class="command-error">${escapeHtml(connector.error)}</div>` : ''}
      <div class="command-calendar-list">${rows || '<div class="command-empty">No upcoming events.</div>'}</div>
      ${renderConnectorActions(connector)}
    </article>`;
}

function renderAgentInboxCard(connector) {
  const status = connector.status || 'error';
  const rows = (Array.isArray(connector.items) ? connector.items : []).slice(0, 6).map(item => `
    <div class="command-review-row">
      <div class="command-review-copy">
        <span>${escapeHtml(item.title || 'Agent request')}</span>
        <small>${escapeHtml(item.detail || '')}</small>
      </div>
      <div class="command-review-actions">
        <button class="command-task-mini" data-action="command-review-toggle-detail" type="button">Details</button>
        ${item.path ? `<button class="command-task-mini" data-action="command-memory-open" data-path="${escapeHtml(item.path)}" type="button">Open</button>` : ''}
      </div>
      <div class="command-review-detail" hidden>
        <div class="command-plan-title">${escapeHtml(item.status || 'agent')}</div>
        <p>${escapeHtml(item.body || item.detail || 'No extra detail available.')}</p>
      </div>
    </div>`).join('');
  return `
    <article class="command-card command-agent-card is-${escapeHtml(status)}">
      <div class="command-card-head">
        <div>
          <div class="command-kicker">${escapeHtml(connector.kind || 'agents')}</div>
          <h3>${escapeHtml(connector.label || 'Agent Inbox')}</h3>
        </div>
        <span class="command-status">${escapeHtml(connectorStatusLabel(status))}</span>
      </div>
      ${connector.summary ? `<div class="command-summary">${escapeHtml(connector.summary)}</div>` : ''}
      ${connector.error ? `<div class="command-error">${escapeHtml(connector.error)}</div>` : ''}
      <div class="command-review-list">${rows || '<div class="command-empty">No agent requests.</div>'}</div>
    </article>`;
}

function renderMemoryCard(connector) {
  const status = connector.status || 'error';
  return `
    <article class="command-card command-memory-card is-${escapeHtml(status)}">
      <div class="command-card-head">
        <div>
          <div class="command-kicker">${escapeHtml(connector.kind || 'memory')}</div>
          <h3>${escapeHtml(connector.label || 'Memory Search')}</h3>
        </div>
        <span class="command-status">${escapeHtml(connectorStatusLabel(status))}</span>
      </div>
      ${connector.summary ? `<div class="command-summary">${escapeHtml(connector.summary)}</div>` : ''}
      ${connector.error ? `<div class="command-error">${escapeHtml(connector.error)}</div>` : ''}
      <form class="command-memory-form" data-action="command-memory-search">
        <input class="command-task-input" data-role="command-memory-query" placeholder="Search projects, notes, tasks..." autocomplete="off">
        <button class="command-task-mini" type="submit">Search</button>
        <button class="command-task-mini" data-action="command-memory-brief" type="button">Brief</button>
        <button class="command-task-mini" data-action="command-memory-reindex" type="button">Reindex</button>
      </form>
      <div class="command-review-list" data-role="command-memory-results"></div>
    </article>`;
}

function renderNotesCard(connector) {
  const status = connector.status || 'error';
  const notes = Array.isArray(connector.items) ? connector.items : [];
  const rows = notes.slice(0, 6).map(note => `
    <div class="command-note-row" data-note-id="${escapeHtml(note.id || '')}">
      <input class="command-task-input" data-role="command-note-title" value="${escapeHtml(note.title || '')}" placeholder="Note title">
      <textarea class="command-note-body" data-role="command-note-body" placeholder="Note body...">${escapeHtml(note.body || note.detail || '')}</textarea>
      <div class="command-actions compact-row">
        <button class="command-task-mini" data-action="command-note-save" data-note-id="${escapeHtml(note.id || '')}" type="button">Save</button>
        <button class="command-task-mini" data-action="command-note-delete" data-note-id="${escapeHtml(note.id || '')}" type="button">Delete</button>
      </div>
    </div>`).join('');
  return `
    <article class="command-card command-notes-card is-${escapeHtml(status)}">
      <div class="command-card-head">
        <div>
          <div class="command-kicker">${escapeHtml(connector.kind || 'notes')}</div>
          <h3>${escapeHtml(connector.label || 'Notes')}</h3>
        </div>
        <span class="command-status">${escapeHtml(connectorStatusLabel(status))}</span>
      </div>
      ${connector.error ? `<div class="command-error">${escapeHtml(connector.error)}</div>` : ''}
      <div class="command-note-row is-new">
        <input class="command-task-input" data-role="command-note-title" placeholder="New note title">
        <textarea class="command-note-body" data-role="command-note-body" placeholder="Write a quick note..."></textarea>
        <div class="command-actions compact-row">
          <button class="command-task-mini" data-action="command-note-save" type="button">Save new note</button>
        </div>
      </div>
      <div class="command-notes-list">${rows || '<div class="command-empty">No notes yet.</div>'}</div>
    </article>`;
}

function renderConnectorCard(connector) {
  if (connector.id === 'tasks') return renderTaskConnectorCard(connector);
  if (connector.id === 'whatsapp' || connector.id === 'gmail') return renderReviewConnectorCard(connector);
  if (connector.id === 'daily-systems') return renderDailySystemsCard(connector);
  if (connector.id === 'calendar') return renderCalendarCard(connector);
  if (connector.id === 'agent-inbox') return renderAgentInboxCard(connector);
  if (connector.id === 'memory') return renderMemoryCard(connector);
  if (connector.id === 'notes') return renderNotesCard(connector);
  const status = connector.status || 'error';
  const items = Array.isArray(connector.items) ? connector.items : [];
  const itemRows = items.slice(0, 4).map(item => `
    <div class="command-item">
      <span>${escapeHtml(item.title || item.label || 'Item')}</span>
      <small>${escapeHtml(item.detail || item.source || '')}</small>
    </div>
  `).join('');
  return `
    <article class="command-card is-${escapeHtml(status)}">
      <div class="command-card-head">
        <div>
          <div class="command-kicker">${escapeHtml(connector.kind || connector.id || 'connector')}</div>
          <h3>${escapeHtml(connector.label || connector.id || 'Connector')}</h3>
        </div>
        <span class="command-status">${escapeHtml(connectorStatusLabel(status))}</span>
      </div>
      ${connector.summary ? `<div class="command-summary">${escapeHtml(connector.summary)}</div>` : ''}
      ${connector.error ? `<div class="command-error">${escapeHtml(connector.error)}</div>` : ''}
      ${itemRows ? `<div class="command-items">${itemRows}</div>` : '<div class="command-empty">No live items.</div>'}
      ${connector.id === 'whatsapp' ? renderWhatsAppPlanRows(connector) : ''}
      ${renderConnectorActions(connector)}
    </article>
  `;
}

function renderCommandCenterHtml(summary) {
  if (!summary || summary.status === 'disconnected') {
    return `
      <section class="command-center offline">
        <button class="command-center-head" data-action="refresh-command-center" type="button">
          <span>
            <span class="command-kicker">Command Center</span>
            <strong>Connector server offline</strong>
          </span>
          <span class="command-status">Refresh</span>
        </button>
        <div class="command-error">${escapeHtml(summary?.error || 'Start the optional connector server to show Gmail, Calendar, WhatsApp, tasks, or local AI cards.')}</div>
      </section>`;
  }

  const connectors = Array.isArray(summary.connectors) ? summary.connectors : [];
  const hidden = getHiddenConnectors();
  const visibleConnectors = connectors.filter(c => !hidden.has(String(c.id)));
  const okCount = visibleConnectors.filter(c => c.status === 'ok').length;
  const toggleRows = connectors.map(c => `
          <label class="command-connector-toggle">
            <input type="checkbox" data-role="command-connector-toggle" data-connector-id="${escapeHtml(c.id)}" ${hidden.has(String(c.id)) ? '' : 'checked'}>
            <span>${escapeHtml(c.label || c.id)}</span>
          </label>`).join('');
  return `
    <section class="command-center">
      <button class="command-center-head" data-action="refresh-command-center" type="button">
        <span>
          <span class="command-kicker">Command Center</span>
          <strong>${okCount}/${connectors.length} connectors live</strong>
        </span>
        <span class="command-status">${escapeHtml(summary.source || 'live')}</span>
      </button>
      <details class="command-settings">
        <summary>Settings</summary>
        <form class="command-settings-form" data-action="command-settings-save">
          <label>
            <span>Connector URL</span>
            <input class="command-task-input" data-role="command-settings-url" value="${escapeHtml(connectorBaseUrl())}" placeholder="${escapeHtml(DEFAULT_CONNECTOR_URL)}">
          </label>
          <label>
            <span>Codex path</span>
            <input class="command-task-input" data-role="command-settings-codex-path" value="${escapeHtml(localStorage.getItem(CODEX_PATH_STORAGE_KEY) || '')}" placeholder="Optional local workspace path">
          </label>
          ${toggleRows ? `<div class="command-connector-toggles">
            <span class="command-plan-title">Show connectors</span>
            <div class="command-connector-toggle-grid">${toggleRows}</div>
          </div>` : ''}
          <button class="command-task-mini" type="submit">Save</button>
          <button class="command-task-mini" data-action="command-codex-open" type="button">Open Codex</button>
        </form>
        <div class="command-setup-help">
          <div class="command-plan-title">Connector setup</div>
          <code>npm run connector</code>
          <code>COMMAND_TAB_BACKEND_URL=http://127.0.0.1:8765 npm run connector</code>
          <code>cp -R examples/context ./command-tab-context</code>
        </div>
      </details>
      <div class="command-grid">
        ${visibleConnectors.map(renderConnectorCard).join('') || '<div class="command-empty">All connectors hidden. Enable some in Settings.</div>'}
      </div>
    </section>`;
}

async function renderCommandCenter() {
  const slot = document.getElementById('commandCenterSlot');
  if (!slot) return;
  const summary = await fetchCommandSummary();
  slot.innerHTML = renderCommandCenterHtml(summary);
}

/**
 * checkAndShowEmptyState()
 *
 * Shows a cheerful "Inbox zero" message when all domain cards are gone.
 */
function checkAndShowEmptyState() {
  const missionsEl = document.getElementById('openTabsMissions');
  if (!missionsEl) return;

  const remaining = missionsEl.querySelectorAll('.mission-card:not(.closing)').length;
  if (remaining > 0) return;

  missionsEl.innerHTML = `
    <div class="missions-empty-state">
      <div class="empty-checkmark">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" />
        </svg>
      </div>
      <div class="empty-title">Inbox zero, but for tabs.</div>
      <div class="empty-subtitle">You're free.</div>
    </div>
  `;

  const countEl = document.getElementById('openTabsSectionCount');
  if (countEl) countEl.textContent = '0 domains';
}

/**
 * timeAgo(dateStr)
 *
 * Converts an ISO date string into a human-friendly relative time.
 * "2026-04-04T10:00:00Z" → "2 hrs ago" or "yesterday"
 */
function timeAgo(dateStr) {
  if (!dateStr) return '';
  const then = new Date(dateStr);
  const now  = new Date();
  const diffMins  = Math.floor((now - then) / 60000);
  const diffHours = Math.floor((now - then) / 3600000);
  const diffDays  = Math.floor((now - then) / 86400000);

  if (diffMins < 1)   return 'just now';
  if (diffMins < 60)  return diffMins + ' min ago';
  if (diffHours < 24) return diffHours + ' hr' + (diffHours !== 1 ? 's' : '') + ' ago';
  if (diffDays === 1) return 'yesterday';
  return diffDays + ' days ago';
}

/**
 * getGreeting() — "Good morning / afternoon / evening"
 */
function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

/**
 * getDateDisplay() — "Friday, April 4, 2026"
 */
function getDateDisplay() {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year:    'numeric',
    month:   'long',
    day:     'numeric',
  });
}


/* ----------------------------------------------------------------
   DOMAIN & TITLE CLEANUP HELPERS
   ---------------------------------------------------------------- */

// Map of known hostnames → friendly display names.
const FRIENDLY_DOMAINS = {
  'github.com':           'GitHub',
  'www.github.com':       'GitHub',
  'gist.github.com':      'GitHub Gist',
  'youtube.com':          'YouTube',
  'www.youtube.com':      'YouTube',
  'music.youtube.com':    'YouTube Music',
  'x.com':                'X',
  'www.x.com':            'X',
  'twitter.com':          'X',
  'www.twitter.com':      'X',
  'reddit.com':           'Reddit',
  'www.reddit.com':       'Reddit',
  'old.reddit.com':       'Reddit',
  'substack.com':         'Substack',
  'www.substack.com':     'Substack',
  'medium.com':           'Medium',
  'www.medium.com':       'Medium',
  'linkedin.com':         'LinkedIn',
  'www.linkedin.com':     'LinkedIn',
  'stackoverflow.com':    'Stack Overflow',
  'www.stackoverflow.com':'Stack Overflow',
  'news.ycombinator.com': 'Hacker News',
  'google.com':           'Google',
  'www.google.com':       'Google',
  'mail.google.com':      'Gmail',
  'docs.google.com':      'Google Docs',
  'drive.google.com':     'Google Drive',
  'calendar.google.com':  'Google Calendar',
  'meet.google.com':      'Google Meet',
  'gemini.google.com':    'Gemini',
  'chatgpt.com':          'ChatGPT',
  'www.chatgpt.com':      'ChatGPT',
  'chat.openai.com':      'ChatGPT',
  'claude.ai':            'Claude',
  'www.claude.ai':        'Claude',
  'code.claude.com':      'Claude Code',
  'notion.so':            'Notion',
  'www.notion.so':        'Notion',
  'figma.com':            'Figma',
  'www.figma.com':        'Figma',
  'slack.com':            'Slack',
  'app.slack.com':        'Slack',
  'discord.com':          'Discord',
  'www.discord.com':      'Discord',
  'wikipedia.org':        'Wikipedia',
  'en.wikipedia.org':     'Wikipedia',
  'amazon.com':           'Amazon',
  'www.amazon.com':       'Amazon',
  'netflix.com':          'Netflix',
  'www.netflix.com':      'Netflix',
  'spotify.com':          'Spotify',
  'open.spotify.com':     'Spotify',
  'vercel.com':           'Vercel',
  'www.vercel.com':       'Vercel',
  'npmjs.com':            'npm',
  'www.npmjs.com':        'npm',
  'developer.mozilla.org':'MDN',
  'arxiv.org':            'arXiv',
  'www.arxiv.org':        'arXiv',
  'huggingface.co':       'Hugging Face',
  'www.huggingface.co':   'Hugging Face',
  'producthunt.com':      'Product Hunt',
  'www.producthunt.com':  'Product Hunt',
  'xiaohongshu.com':      'RedNote',
  'www.xiaohongshu.com':  'RedNote',
  'local-files':          'Local Files',
};

function friendlyDomain(hostname) {
  if (!hostname) return '';
  if (FRIENDLY_DOMAINS[hostname]) return FRIENDLY_DOMAINS[hostname];

  if (hostname.endsWith('.substack.com') && hostname !== 'substack.com') {
    return capitalize(hostname.replace('.substack.com', '')) + "'s Substack";
  }
  if (hostname.endsWith('.github.io')) {
    return capitalize(hostname.replace('.github.io', '')) + ' (GitHub Pages)';
  }

  let clean = hostname
    .replace(/^www\./, '')
    .replace(/\.(com|org|net|io|co|ai|dev|app|so|me|xyz|info|us|uk|co\.uk|co\.jp)$/, '');

  return clean.split('.').map(part => capitalize(part)).join(' ');
}

function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function stripTitleNoise(title) {
  if (!title) return '';
  // Strip leading notification count: "(2) Title"
  title = title.replace(/^\(\d+\+?\)\s*/, '');
  // Strip inline counts like "Inbox (16,359)"
  title = title.replace(/\s*\([\d,]+\+?\)\s*/g, ' ');
  // Strip email addresses (privacy + cleaner display)
  title = title.replace(/\s*[\-\u2010-\u2015]\s*[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '');
  title = title.replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '');
  // Clean X/Twitter format
  title = title.replace(/\s+on X:\s*/, ': ');
  title = title.replace(/\s*\/\s*X\s*$/, '');
  return title.trim();
}

function cleanTitle(title, hostname) {
  if (!title || !hostname) return title || '';

  const friendly = friendlyDomain(hostname);
  const domain   = hostname.replace(/^www\./, '');
  const seps     = [' - ', ' | ', ' — ', ' · ', ' – '];

  for (const sep of seps) {
    const idx = title.lastIndexOf(sep);
    if (idx === -1) continue;
    const suffix     = title.slice(idx + sep.length).trim();
    const suffixLow  = suffix.toLowerCase();
    if (
      suffixLow === domain.toLowerCase() ||
      suffixLow === friendly.toLowerCase() ||
      suffixLow === domain.replace(/\.\w+$/, '').toLowerCase() ||
      domain.toLowerCase().includes(suffixLow) ||
      friendly.toLowerCase().includes(suffixLow)
    ) {
      const cleaned = title.slice(0, idx).trim();
      if (cleaned.length >= 5) return cleaned;
    }
  }
  return title;
}

function smartTitle(title, url) {
  if (!url) return title || '';
  let pathname = '', hostname = '';
  try { const u = new URL(url); pathname = u.pathname; hostname = u.hostname; }
  catch { return title || ''; }

  const titleIsUrl = !title || title === url || title.startsWith(hostname) || title.startsWith('http');

  if ((hostname === 'x.com' || hostname === 'twitter.com' || hostname === 'www.x.com') && pathname.includes('/status/')) {
    const username = pathname.split('/')[1];
    if (username) return titleIsUrl ? `Post by @${username}` : title;
  }

  if (hostname === 'github.com' || hostname === 'www.github.com') {
    const parts = pathname.split('/').filter(Boolean);
    if (parts.length >= 2) {
      const [owner, repo, ...rest] = parts;
      if (rest[0] === 'issues' && rest[1]) return `${owner}/${repo} Issue #${rest[1]}`;
      if (rest[0] === 'pull'   && rest[1]) return `${owner}/${repo} PR #${rest[1]}`;
      if (rest[0] === 'blob' || rest[0] === 'tree') return `${owner}/${repo} — ${rest.slice(2).join('/')}`;
      if (titleIsUrl) return `${owner}/${repo}`;
    }
  }

  if ((hostname === 'www.youtube.com' || hostname === 'youtube.com') && pathname === '/watch') {
    if (titleIsUrl) return 'YouTube Video';
  }

  if ((hostname === 'www.reddit.com' || hostname === 'reddit.com' || hostname === 'old.reddit.com') && pathname.includes('/comments/')) {
    const parts  = pathname.split('/').filter(Boolean);
    const subIdx = parts.indexOf('r');
    if (subIdx !== -1 && parts[subIdx + 1]) {
      if (titleIsUrl) return `r/${parts[subIdx + 1]} post`;
    }
  }

  return title || url;
}


/* ----------------------------------------------------------------
   SVG ICON STRINGS
   ---------------------------------------------------------------- */
const ICONS = {
  tabs:    `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M3 8.25V18a2.25 2.25 0 0 0 2.25 2.25h13.5A2.25 2.25 0 0 0 21 18V8.25m-18 0V6a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 6v2.25m-18 0h18" /></svg>`,
  close:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>`,
  archive: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5m6 4.125l2.25 2.25m0 0l2.25 2.25M12 13.875l2.25-2.25M12 13.875l-2.25 2.25M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z" /></svg>`,
  focus:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 19.5 15-15m0 0H8.25m11.25 0v11.25" /></svg>`,
};


/* ----------------------------------------------------------------
   IN-MEMORY STORE FOR OPEN-TAB GROUPS
   ---------------------------------------------------------------- */
let domainGroups = [];


/* ----------------------------------------------------------------
   HELPER: filter out browser-internal pages
   ---------------------------------------------------------------- */

/**
 * getRealTabs()
 *
 * Returns tabs that are real web pages — no chrome://, extension
 * pages, about:blank, etc.
 */
function getRealTabs() {
  return openTabs.filter(t => {
    const url = t.url || '';
    return (
      !url.startsWith('chrome://') &&
      !url.startsWith('chrome-extension://') &&
      !url.startsWith('about:') &&
      !url.startsWith('edge://') &&
      !url.startsWith('brave://')
    );
  });
}

/**
 * checkTabOutDupes()
 *
 * Counts how many Command Tab pages are open. If more than 1,
 * shows a banner offering to close the extras.
 */
function checkTabOutDupes() {
  const tabOutTabs = openTabs.filter(t => t.isTabOut);
  const banner  = document.getElementById('tabOutDupeBanner');
  const countEl = document.getElementById('tabOutDupeCount');
  if (!banner) return;

  if (tabOutTabs.length > 1) {
    if (countEl) countEl.textContent = tabOutTabs.length;
    banner.style.display = 'flex';
  } else {
    banner.style.display = 'none';
  }
}


/* ----------------------------------------------------------------
   OVERFLOW CHIPS ("+N more" expand button in domain cards)
   ---------------------------------------------------------------- */

function buildOverflowChips(hiddenTabs, urlCounts = {}) {
  const hiddenChips = hiddenTabs.map(tab => {
    const label    = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), '');
    const count    = urlCounts[tab.url] || 1;
    const dupeTag  = count > 1 ? ` <span class="chip-dupe-badge">(${count}x)</span>` : '';
    const chipClass = count > 1 ? ' chip-has-dupes' : '';
    const safeUrl   = (tab.url || '').replace(/"/g, '&quot;');
    const safeTitle = label.replace(/"/g, '&quot;');
    let domain = '';
    try { domain = new URL(tab.url).hostname; } catch {}
    const faviconUrl = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=16` : '';
    return `<div class="page-chip clickable${chipClass}" data-action="focus-tab" data-tab-url="${safeUrl}" title="${safeTitle}">
      ${faviconUrl ? `<img class="chip-favicon" src="${faviconUrl}" alt="" onerror="this.style.display='none'">` : ''}
      <span class="chip-text">${label}</span>${dupeTag}
      <div class="chip-actions">
        <button class="chip-action chip-save" data-action="defer-single-tab" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="Save for later">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>
        </button>
        <button class="chip-action chip-close" data-action="close-single-tab" data-tab-url="${safeUrl}" title="Close this tab">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </div>`;
  }).join('');

  return `
    <div class="page-chips-overflow" style="display:none">${hiddenChips}</div>
    <div class="page-chip page-chip-overflow clickable" data-action="expand-chips">
      <span class="chip-text">+${hiddenTabs.length} more</span>
    </div>`;
}


/* ----------------------------------------------------------------
   DOMAIN CARD RENDERER
   ---------------------------------------------------------------- */

/**
 * renderDomainCard(group, groupIndex)
 *
 * Builds the HTML for one domain group card.
 * group = { domain: string, tabs: [{ url, title, id, windowId, active }] }
 */
function renderDomainCard(group) {
  const tabs      = group.tabs || [];
  const tabCount  = tabs.length;
  const isLanding = group.domain === '__landing-pages__';
  const stableId  = 'domain-' + group.domain.replace(/[^a-z0-9]/g, '-');

  // Count duplicates (exact URL match)
  const urlCounts = {};
  for (const tab of tabs) urlCounts[tab.url] = (urlCounts[tab.url] || 0) + 1;
  const dupeUrls   = Object.entries(urlCounts).filter(([, c]) => c > 1);
  const hasDupes   = dupeUrls.length > 0;
  const totalExtras = dupeUrls.reduce((s, [, c]) => s + c - 1, 0);

  const tabBadge = `<span class="open-tabs-badge">
    ${ICONS.tabs}
    ${tabCount} tab${tabCount !== 1 ? 's' : ''} open
  </span>`;

  const dupeBadge = hasDupes
    ? `<span class="open-tabs-badge" style="color:var(--accent-amber);background:rgba(200,113,58,0.08);">
        ${totalExtras} duplicate${totalExtras !== 1 ? 's' : ''}
      </span>`
    : '';

  // Deduplicate for display: show each URL once, with (Nx) badge if duped
  const seen = new Set();
  const uniqueTabs = [];
  for (const tab of tabs) {
    if (!seen.has(tab.url)) { seen.add(tab.url); uniqueTabs.push(tab); }
  }

  const visibleTabs = uniqueTabs.slice(0, 8);
  const extraCount  = uniqueTabs.length - visibleTabs.length;

  const pageChips = visibleTabs.map(tab => {
    let label = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), group.domain);
    // For localhost tabs, prepend port number so you can tell projects apart
    try {
      const parsed = new URL(tab.url);
      if (parsed.hostname === 'localhost' && parsed.port) label = `${parsed.port} ${label}`;
    } catch {}
    const count    = urlCounts[tab.url];
    const dupeTag  = count > 1 ? ` <span class="chip-dupe-badge">(${count}x)</span>` : '';
    const chipClass = count > 1 ? ' chip-has-dupes' : '';
    const safeUrl   = (tab.url || '').replace(/"/g, '&quot;');
    const safeTitle = label.replace(/"/g, '&quot;');
    let domain = '';
    try { domain = new URL(tab.url).hostname; } catch {}
    const faviconUrl = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=16` : '';
    return `<div class="page-chip clickable${chipClass}" data-action="focus-tab" data-tab-url="${safeUrl}" title="${safeTitle}">
      ${faviconUrl ? `<img class="chip-favicon" src="${faviconUrl}" alt="" onerror="this.style.display='none'">` : ''}
      <span class="chip-text">${label}</span>${dupeTag}
      <div class="chip-actions">
        <button class="chip-action chip-save" data-action="defer-single-tab" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="Save for later">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>
        </button>
        <button class="chip-action chip-close" data-action="close-single-tab" data-tab-url="${safeUrl}" title="Close this tab">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </div>`;
  }).join('') + (extraCount > 0 ? buildOverflowChips(uniqueTabs.slice(8), urlCounts) : '');

  let actionsHtml = `
    <button class="action-btn close-tabs" data-action="close-domain-tabs" data-domain-id="${stableId}">
      ${ICONS.close}
      Close all ${tabCount} tab${tabCount !== 1 ? 's' : ''}
    </button>`;

  if (hasDupes) {
    const dupeUrlsEncoded = dupeUrls.map(([url]) => encodeURIComponent(url)).join(',');
    actionsHtml += `
      <button class="action-btn" data-action="dedup-keep-one" data-dupe-urls="${dupeUrlsEncoded}">
        Close ${totalExtras} duplicate${totalExtras !== 1 ? 's' : ''}
      </button>`;
  }

  return `
    <div class="mission-card domain-card ${hasDupes ? 'has-amber-bar' : 'has-neutral-bar'}" data-domain-id="${stableId}">
      <div class="status-bar"></div>
      <div class="mission-content">
        <div class="mission-top">
          <span class="mission-name">${isLanding ? 'Homepages' : (group.label || friendlyDomain(group.domain))}</span>
          ${tabBadge}
          ${dupeBadge}
        </div>
        <div class="mission-pages">${pageChips}</div>
        <div class="actions">${actionsHtml}</div>
      </div>
      <div class="mission-meta">
        <div class="mission-page-count">${tabCount}</div>
        <div class="mission-page-label">tabs</div>
      </div>
    </div>`;
}


/* ----------------------------------------------------------------
   SAVED FOR LATER — Render Checklist Column
   ---------------------------------------------------------------- */

/**
 * renderDeferredColumn()
 *
 * Reads saved tabs from chrome.storage.local and renders the right-side
 * "Saved for Later" checklist column. Shows active items as a checklist
 * and completed items in a collapsible archive.
 */
async function renderDeferredColumn() {
  const column         = document.getElementById('deferredColumn');
  const list           = document.getElementById('deferredList');
  const empty          = document.getElementById('deferredEmpty');
  const countEl        = document.getElementById('deferredCount');
  const archiveEl      = document.getElementById('deferredArchive');
  const archiveCountEl = document.getElementById('archiveCount');
  const archiveList    = document.getElementById('archiveList');

  if (!column) return;

  try {
    const { active, archived } = await getSavedTabs();

    // Hide the entire column if there's nothing to show
    if (active.length === 0 && archived.length === 0) {
      column.style.display = 'none';
      return;
    }

    column.style.display = 'block';

    // Render active checklist items
    if (active.length > 0) {
      countEl.textContent = `${active.length} item${active.length !== 1 ? 's' : ''}`;
      list.innerHTML = active.map(item => renderDeferredItem(item)).join('');
      list.style.display = 'block';
      empty.style.display = 'none';
    } else {
      list.style.display = 'none';
      countEl.textContent = '';
      empty.style.display = 'block';
    }

    // Render archive section
    if (archived.length > 0) {
      archiveCountEl.textContent = `(${archived.length})`;
      archiveList.innerHTML = archived.map(item => renderArchiveItem(item)).join('');
      archiveEl.style.display = 'block';
    } else {
      archiveEl.style.display = 'none';
    }

  } catch (err) {
    console.warn('[command-tab] Could not load saved tabs:', err);
    column.style.display = 'none';
  }
}

/**
 * renderDeferredItem(item)
 *
 * Builds HTML for one active checklist item: checkbox, title link,
 * domain, time ago, dismiss button.
 */
function renderDeferredItem(item) {
  let domain = '';
  try { domain = new URL(item.url).hostname.replace(/^www\./, ''); } catch {}
  const faviconUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=16`;
  const ago = timeAgo(item.savedAt);

  return `
    <div class="deferred-item" data-deferred-id="${item.id}">
      <input type="checkbox" class="deferred-checkbox" data-action="check-deferred" data-deferred-id="${item.id}">
      <div class="deferred-info">
        <a href="${item.url}" target="_blank" rel="noopener" class="deferred-title" title="${(item.title || '').replace(/"/g, '&quot;')}">
          <img src="${faviconUrl}" alt="" style="width:14px;height:14px;vertical-align:-2px;margin-right:4px" onerror="this.style.display='none'">${item.title || item.url}
        </a>
        <div class="deferred-meta">
          <span>${domain}</span>
          <span>${ago}</span>
        </div>
      </div>
      <button class="deferred-dismiss" data-action="dismiss-deferred" data-deferred-id="${item.id}" title="Dismiss">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
      </button>
    </div>`;
}

/**
 * renderArchiveItem(item)
 *
 * Builds HTML for one completed/archived item (simpler: just title + date).
 */
function renderArchiveItem(item) {
  const ago = item.completedAt ? timeAgo(item.completedAt) : timeAgo(item.savedAt);
  return `
    <div class="archive-item">
      <a href="${item.url}" target="_blank" rel="noopener" class="archive-item-title" title="${(item.title || '').replace(/"/g, '&quot;')}">
        ${item.title || item.url}
      </a>
      <span class="archive-item-date">${ago}</span>
    </div>`;
}


/* ----------------------------------------------------------------
   MAIN DASHBOARD RENDERER
   ---------------------------------------------------------------- */

/**
 * renderStaticDashboard()
 *
 * The main render function:
 * 1. Paints greeting + date
 * 2. Fetches open tabs via chrome.tabs.query()
 * 3. Groups tabs by domain (with landing pages pulled out to their own group)
 * 4. Renders domain cards
 * 5. Updates footer stats
 * 6. Renders the "Saved for Later" checklist
 */
async function renderStaticDashboard() {
  // --- Header ---
  const greetingEl = document.getElementById('greeting');
  const dateEl     = document.getElementById('dateDisplay');
  if (greetingEl) greetingEl.textContent = getGreeting();
  if (dateEl)     dateEl.textContent     = getDateDisplay();

  // --- Fetch tabs ---
  await fetchOpenTabs();
  await renderCommandCenter();
  const realTabs = getRealTabs();

  // --- Group tabs by domain ---
  // Landing pages (Gmail inbox, Twitter home, etc.) get their own special group
  // so they can be closed together without affecting content tabs on the same domain.
  const LANDING_PAGE_PATTERNS = [
    { hostname: 'mail.google.com', test: (p, h) =>
        !h.includes('#inbox/') && !h.includes('#sent/') && !h.includes('#search/') },
    { hostname: 'x.com',               pathExact: ['/home'] },
    { hostname: 'www.linkedin.com',    pathExact: ['/'] },
    { hostname: 'github.com',          pathExact: ['/'] },
    { hostname: 'www.youtube.com',     pathExact: ['/'] },
    // Merge personal patterns from config.local.js (if it exists)
    ...(typeof LOCAL_LANDING_PAGE_PATTERNS !== 'undefined' ? LOCAL_LANDING_PAGE_PATTERNS : []),
  ];

  function isLandingPage(url) {
    try {
      const parsed = new URL(url);
      return LANDING_PAGE_PATTERNS.some(p => {
        // Support both exact hostname and suffix matching (for wildcard subdomains)
        const hostnameMatch = p.hostname
          ? parsed.hostname === p.hostname
          : p.hostnameEndsWith
            ? parsed.hostname.endsWith(p.hostnameEndsWith)
            : false;
        if (!hostnameMatch) return false;
        if (p.test)       return p.test(parsed.pathname, url);
        if (p.pathPrefix) return parsed.pathname.startsWith(p.pathPrefix);
        if (p.pathExact)  return p.pathExact.includes(parsed.pathname);
        return parsed.pathname === '/';
      });
    } catch { return false; }
  }

  domainGroups = [];
  const groupMap    = {};
  const landingTabs = [];

  // Custom group rules from config.local.js (if any)
  const customGroups = typeof LOCAL_CUSTOM_GROUPS !== 'undefined' ? LOCAL_CUSTOM_GROUPS : [];

  // Check if a URL matches a custom group rule; returns the rule or null
  function matchCustomGroup(url) {
    try {
      const parsed = new URL(url);
      return customGroups.find(r => {
        const hostMatch = r.hostname
          ? parsed.hostname === r.hostname
          : r.hostnameEndsWith
            ? parsed.hostname.endsWith(r.hostnameEndsWith)
            : false;
        if (!hostMatch) return false;
        if (r.pathPrefix) return parsed.pathname.startsWith(r.pathPrefix);
        return true; // hostname matched, no path filter
      }) || null;
    } catch { return null; }
  }

  for (const tab of realTabs) {
    try {
      if (isLandingPage(tab.url)) {
        landingTabs.push(tab);
        continue;
      }

      // Check custom group rules first (e.g. merge subdomains, split by path)
      const customRule = matchCustomGroup(tab.url);
      if (customRule) {
        const key = customRule.groupKey;
        if (!groupMap[key]) groupMap[key] = { domain: key, label: customRule.groupLabel, tabs: [] };
        groupMap[key].tabs.push(tab);
        continue;
      }

      let hostname;
      if (tab.url && tab.url.startsWith('file://')) {
        hostname = 'local-files';
      } else {
        hostname = new URL(tab.url).hostname;
      }
      if (!hostname) continue;

      if (!groupMap[hostname]) groupMap[hostname] = { domain: hostname, tabs: [] };
      groupMap[hostname].tabs.push(tab);
    } catch {
      // Skip malformed URLs
    }
  }

  if (landingTabs.length > 0) {
    groupMap['__landing-pages__'] = { domain: '__landing-pages__', tabs: landingTabs };
  }

  // Sort: landing pages first, then domains from landing page sites, then by tab count
  // Collect exact hostnames and suffix patterns for priority sorting
  const landingHostnames = new Set(LANDING_PAGE_PATTERNS.map(p => p.hostname).filter(Boolean));
  const landingSuffixes = LANDING_PAGE_PATTERNS.map(p => p.hostnameEndsWith).filter(Boolean);
  function isLandingDomain(domain) {
    if (landingHostnames.has(domain)) return true;
    return landingSuffixes.some(s => domain.endsWith(s));
  }
  domainGroups = Object.values(groupMap).sort((a, b) => {
    const aIsLanding = a.domain === '__landing-pages__';
    const bIsLanding = b.domain === '__landing-pages__';
    if (aIsLanding !== bIsLanding) return aIsLanding ? -1 : 1;

    const aIsPriority = isLandingDomain(a.domain);
    const bIsPriority = isLandingDomain(b.domain);
    if (aIsPriority !== bIsPriority) return aIsPriority ? -1 : 1;

    return b.tabs.length - a.tabs.length;
  });

  // --- Render domain cards ---
  const openTabsSection      = document.getElementById('openTabsSection');
  const openTabsMissionsEl   = document.getElementById('openTabsMissions');
  const openTabsSectionCount = document.getElementById('openTabsSectionCount');
  const openTabsSectionTitle = document.getElementById('openTabsSectionTitle');

  if (domainGroups.length > 0 && openTabsSection) {
    if (openTabsSectionTitle) openTabsSectionTitle.textContent = 'Open tabs';
    openTabsSectionCount.innerHTML = `${domainGroups.length} domain${domainGroups.length !== 1 ? 's' : ''} &nbsp;&middot;&nbsp; <button class="action-btn close-tabs" data-action="close-all-open-tabs" style="font-size:11px;padding:3px 10px;">${ICONS.close} Close all ${realTabs.length} tabs</button>`;
    openTabsMissionsEl.innerHTML = domainGroups.map(g => renderDomainCard(g)).join('');
    openTabsSection.style.display = 'block';
  } else if (openTabsSection) {
    openTabsSection.style.display = 'none';
  }

  // --- Footer stats ---
  const statTabs = document.getElementById('statTabs');
  if (statTabs) statTabs.textContent = openTabs.length;

  // --- Check for duplicate Command Tab tabs ---
  checkTabOutDupes();

  // --- Render "Saved for Later" column ---
  await renderDeferredColumn();
}

async function renderDashboard() {
  await renderStaticDashboard();
}


/* ----------------------------------------------------------------
   EVENT HANDLERS — using event delegation

   One listener on document handles ALL button clicks.
   Think of it as one security guard watching the whole building
   instead of one per door.
   ---------------------------------------------------------------- */

document.addEventListener('click', async (e) => {
  // Walk up the DOM to find the nearest element with data-action
  const actionEl = e.target.closest('[data-action]');
  if (!actionEl) return;

  const action = actionEl.dataset.action;

  // ---- Close duplicate Command Tab tabs ----
  if (action === 'close-tabout-dupes') {
    await closeTabOutDupes();
    playCloseSound();
    const banner = document.getElementById('tabOutDupeBanner');
    if (banner) {
      banner.style.transition = 'opacity 0.4s';
      banner.style.opacity = '0';
      setTimeout(() => { banner.style.display = 'none'; banner.style.opacity = '1'; }, 400);
    }
    showToast('Closed extra Command Tab tabs');
    return;
  }

  if (action === 'refresh-command-center') {
    e.stopPropagation();
    await renderCommandCenter();
    showToast('Command center refreshed');
    return;
  }

  if (action === 'gmail-refresh') {
    e.stopPropagation();
    try {
      await postBackendAction('/api/backend/gmail/refresh');
      await renderCommandCenter();
      showToast('Gmail refreshed');
    } catch (error) {
      showToast(error.message || 'Gmail refresh failed');
      await renderCommandCenter();
    }
    return;
  }

  if (action === 'whatsapp-refresh') {
    e.stopPropagation();
    try {
      await postBackendAction('/api/backend/whatsapp/refresh');
      await renderCommandCenter();
      showToast('WhatsApp refreshed');
    } catch (error) {
      showToast(error.message || 'WhatsApp refresh failed');
      await renderCommandCenter();
    }
    return;
  }

  if (action === 'whatsapp-bridge-restart') {
    e.stopPropagation();
    try {
      await postBackendAction('/api/whatsapp/bridge-restart');
      await renderCommandCenter();
      showToast('WhatsApp bridge restart requested');
    } catch (error) {
      showToast(error.message || 'WhatsApp bridge restart failed');
      await renderCommandCenter();
    }
    return;
  }

  if (action === 'whatsapp-plan-send') {
    e.stopPropagation();
    const planId = actionEl.dataset.planId || '';
    const row = actionEl.closest('.command-plan-row');
    const text = row?.querySelector('[data-role="whatsapp-plan-message"]')?.value.trim() || '';
    if (!planId || !text) {
      showToast('Choose a planned message with text first');
      return;
    }
    const previous = actionEl.textContent;
    actionEl.textContent = 'Sending...';
    actionEl.disabled = true;
    try {
      await postBackendAction('/api/whatsapp/daily-plan/send', { id: planId, text });
      await renderCommandCenter();
      showToast('WhatsApp sent');
    } catch (error) {
      actionEl.textContent = previous || 'Send';
      actionEl.disabled = false;
      showToast(error.message || 'WhatsApp send failed');
      await renderCommandCenter();
    }
    return;
  }

  if (action === 'command-task-check') {
    e.stopPropagation();
    try {
      const checked = actionEl.dataset.checked !== 'true';
      await postBackendAction('/api/tasks/check', taskActionPayload(actionEl, { checked }));
      await renderCommandCenter();
      showToast(checked ? 'Task checked' : 'Task reopened');
    } catch (error) {
      showToast(error.message || 'Task update failed');
      await renderCommandCenter();
    }
    return;
  }

  if (action === 'command-task-pin') {
    e.stopPropagation();
    try {
      const pinned = actionEl.dataset.pinned !== 'true';
      await postBackendAction('/api/tasks/pin', taskActionPayload(actionEl, { pinned }));
      await renderCommandCenter();
      showToast(pinned ? 'Task pinned' : 'Task unpinned');
    } catch (error) {
      showToast(error.message || 'Pin failed');
      await renderCommandCenter();
    }
    return;
  }

  if (action === 'command-task-release') {
    e.stopPropagation();
    try {
      await postBackendAction('/api/tasks/release', taskActionPayload(actionEl));
      await renderCommandCenter();
      showToast('Moved back to task list');
    } catch (error) {
      showToast(error.message || 'Move failed');
      await renderCommandCenter();
    }
    return;
  }

  if (action === 'command-task-remind') {
    e.stopPropagation();
    const date = window.prompt('Remind on date (YYYY-MM-DD)', relativeDate(1));
    if (!date) return;
    try {
      await postBackendAction('/api/tasks/remind', taskActionPayload(actionEl, { date }));
      await renderCommandCenter();
      showToast(`Reminder set for ${date}`);
    } catch (error) {
      showToast(error.message || 'Reminder failed');
      await renderCommandCenter();
    }
    return;
  }

  if (action === 'command-task-agent') {
    e.stopPropagation();
    try {
      await postBackendAction('/api/tasks/agent', taskActionPayload(actionEl));
      await renderCommandCenter();
      showToast('Agent request saved');
    } catch (error) {
      showToast(error.message || 'Agent launch failed');
      await renderCommandCenter();
    }
    return;
  }

  if (action === 'command-task-wa-open') {
    e.stopPropagation();
    openTaskWhatsAppDialog(actionEl);
    return;
  }

  if (action === 'command-task-wa-close') {
    e.stopPropagation();
    document.getElementById('commandTaskWhatsAppModal')?.remove();
    return;
  }

  if (action === 'command-task-wa-send') {
    e.stopPropagation();
    const modal = document.getElementById('commandTaskWhatsAppModal');
    const chat = modal?.querySelector('[data-role="command-task-wa-chat"]')?.value.trim() || '';
    const text = modal?.querySelector('[data-role="command-task-wa-text"]')?.value.trim() || '';
    const status = modal?.querySelector('[data-role="command-task-wa-status"]');
    if (!chat || !text) {
      if (status) status.textContent = 'Chat and message are required.';
      return;
    }
    actionEl.disabled = true;
    actionEl.textContent = 'Sending...';
    try {
      await postBackendAction('/api/whatsapp/send', { chat, text });
      modal?.remove();
      await renderCommandCenter();
      showToast('WhatsApp sent');
    } catch (error) {
      actionEl.disabled = false;
      actionEl.textContent = 'Send WhatsApp';
      if (status) status.textContent = error.message || 'WhatsApp send failed';
      showToast(error.message || 'WhatsApp send failed');
    }
    return;
  }

  if (action === 'command-task-note-open') {
    e.stopPropagation();
    openTaskNoteDialog(actionEl);
    return;
  }

  if (action === 'command-task-note-close') {
    e.stopPropagation();
    document.getElementById('commandTaskNoteModal')?.remove();
    return;
  }

  if (action === 'command-task-note-save') {
    e.stopPropagation();
    const modal = document.getElementById('commandTaskNoteModal');
    const text = modal?.querySelector('[data-role="command-task-note-text"]')?.value.trim() || '';
    const status = modal?.querySelector('[data-role="command-task-note-status"]');
    if (!text) {
      if (status) status.textContent = 'Write a note first.';
      return;
    }
    try {
      await postBackendAction('/api/tasks/note', taskActionPayload(actionEl, { content: text, source: 'Command Tab note' }));
      modal?.remove();
      await renderCommandCenter();
      showToast('Task note saved');
    } catch (error) {
      if (status) status.textContent = error.message || 'Note save failed';
      showToast(error.message || 'Note save failed');
    }
    return;
  }

  if (action === 'command-review-state') {
    e.stopPropagation();
    const connectorId = actionEl.dataset.reviewConnector || '';
    const itemId = actionEl.dataset.reviewId || '';
    const state = actionEl.dataset.reviewState || 'reviewed';
    if (!connectorId || !itemId) return;
    setReviewState(connectorId, itemId, state);
    actionEl.closest('.command-review-row')?.remove();
    showToast(state === 'blocked' ? 'Sender hidden locally' : `Marked ${state}`);
    return;
  }

  if (action === 'command-review-toggle-detail') {
    e.stopPropagation();
    const detail = actionEl.closest('.command-review-row')?.querySelector('.command-review-detail');
    if (detail) detail.hidden = !detail.hidden;
    return;
  }

  if (action === 'command-review-copy') {
    e.stopPropagation();
    const text = actionEl.dataset.copyText || '';
    try {
      await navigator.clipboard.writeText(text);
      showToast('Copied');
    } catch (error) {
      showToast('Copy failed');
    }
    return;
  }

  if (action === 'command-review-task') {
    e.stopPropagation();
    const title = actionEl.dataset.title || 'Email follow-up';
    const detail = actionEl.dataset.detail || '';
    try {
      await postBackendAction('/api/tasks/add', { title, detail, section: 'Active' });
      await renderCommandCenter();
      showToast('Email task added');
    } catch (error) {
      showToast(error.message || 'Task add failed');
    }
    return;
  }

  if (action === 'command-review-sort') {
    e.stopPropagation();
    const connectorId = actionEl.dataset.reviewConnector || '';
    if (connectorId) localStorage.setItem(reviewSortKey(connectorId), actionEl.value || 'needs');
    await renderCommandCenter();
    return;
  }

  if (action === 'command-habit-check') {
    e.stopPropagation();
    const habitId = actionEl.dataset.habitId || '';
    const checked = actionEl.dataset.checked !== 'true';
    if (!habitId) return;
    try {
      await postBackendAction('/api/habits/check', { habit_id: habitId, checked, metrics: collectHabitMetrics(actionEl) });
      await renderCommandCenter();
      showToast(checked ? 'Habit checked' : 'Habit reopened');
    } catch (error) {
      showToast(error.message || 'Habit save failed');
      await renderCommandCenter();
    }
    return;
  }

  if (action === 'command-habit-metrics-save') {
    e.stopPropagation();
    const habitId = actionEl.dataset.habitId || '';
    if (!habitId) return;
    try {
      await postBackendAction('/api/habits/check', { habit_id: habitId, checked: true, metrics: collectHabitMetrics(actionEl) });
      await renderCommandCenter();
      showToast('Habit metrics saved');
    } catch (error) {
      showToast(error.message || 'Habit metrics failed');
      await renderCommandCenter();
    }
    return;
  }

  if (action === 'command-vietnamese-study') {
    e.stopPropagation();
    try {
      await postBackendAction('/api/vietnamese/study', { note: 'Marked from Command Tab' });
      await renderCommandCenter();
      showToast('Vietnamese marked studied');
    } catch (error) {
      showToast(error.message || 'Vietnamese save failed');
      await renderCommandCenter();
    }
    return;
  }

  if (action === 'command-voice-open' || action === 'command-voice-folder') {
    e.stopPropagation();
    try {
      await postBackendAction(action === 'command-voice-open' ? '/api/voice-notes/open' : '/api/voice-notes/open-folder');
      showToast(action === 'command-voice-open' ? 'Voice app opened' : 'Voice folder opened');
    } catch (error) {
      showToast(error.message || 'Voice open failed');
    }
    return;
  }

  if (action === 'command-voice-play') {
    e.stopPropagation();
    const text = actionEl.dataset.text || '';
    if (!text) {
      showToast('No voice note text available');
      return;
    }
    try {
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
      showToast('Playing latest voice note');
    } catch (error) {
      showToast('Voice playback failed');
    }
    return;
  }

  if (action === 'command-memory-open') {
    e.stopPropagation();
    const path = actionEl.dataset.path || '';
    if (!path) return;
    try {
      await postBackendAction('/api/memory/open', { path });
      showToast('Opened');
    } catch (error) {
      showToast(error.message || 'Open failed');
    }
    return;
  }

  if (action === 'command-memory-brief') {
    e.stopPropagation();
    const card = actionEl.closest('.command-memory-card');
    const query = card?.querySelector('[data-role="command-memory-query"]')?.value.trim() || '';
    const resultsEl = card?.querySelector('[data-role="command-memory-results"]');
    if (!query) {
      showToast('Search query required');
      return;
    }
    try {
      if (resultsEl) resultsEl.innerHTML = '<div class="command-empty">Generating memory brief...</div>';
      const data = await postBackendAction('/api/memory/brief', { query });
      const brief = data.brief || data.summary || '';
      if (resultsEl) {
        resultsEl.innerHTML = brief
          ? `<div class="command-review-detail is-open"><div class="command-plan-title">${escapeHtml(data.model || 'Memory brief')}</div><p>${escapeHtml(brief)}</p></div>`
          : '<div class="command-empty">No brief returned.</div>';
      }
      showToast('Memory brief ready');
    } catch (error) {
      if (resultsEl) resultsEl.innerHTML = `<div class="command-error">${escapeHtml(error.message || 'Memory brief failed')}</div>`;
      showToast(error.message || 'Memory brief failed');
    }
    return;
  }

  if (action === 'command-memory-reindex') {
    e.stopPropagation();
    const card = actionEl.closest('.command-memory-card');
    const resultsEl = card?.querySelector('[data-role="command-memory-results"]');
    try {
      if (resultsEl) resultsEl.innerHTML = '<div class="command-empty">Reindexing memory...</div>';
      const data = await postBackendAction('/api/memory/reindex', {});
      if (resultsEl) resultsEl.innerHTML = `<div class="command-summary">Reindexed. ${escapeHtml(String(data.counts?.total || data.total || ''))} records available.</div>`;
      showToast('Memory reindexed');
    } catch (error) {
      if (resultsEl) resultsEl.innerHTML = `<div class="command-error">${escapeHtml(error.message || 'Memory reindex failed')}</div>`;
      showToast(error.message || 'Memory reindex failed');
    }
    return;
  }

  if (action === 'command-codex-open') {
    e.stopPropagation();
    const form = actionEl.closest('.command-settings-form');
    const pathInput = form?.querySelector('[data-role="command-settings-codex-path"]');
    const path = (pathInput?.value || localStorage.getItem(CODEX_PATH_STORAGE_KEY) || '').trim();
    if (path) localStorage.setItem(CODEX_PATH_STORAGE_KEY, path);
    try {
      await postBackendAction('/api/codex/open', { path });
      showToast('Opened Codex');
    } catch (error) {
      showToast(error.message || 'Open Codex failed');
    }
    return;
  }

  if (action === 'command-note-save') {
    e.stopPropagation();
    const row = actionEl.closest('.command-note-row');
    const title = row?.querySelector('[data-role="command-note-title"]')?.value.trim() || '';
    const body = row?.querySelector('[data-role="command-note-body"]')?.value || '';
    const id = actionEl.dataset.noteId || row?.dataset.noteId || '';
    if (!title && !body.trim()) {
      showToast('Write the note first');
      return;
    }
    try {
      await postBackendAction('/api/notes/save', { id, title: title || 'Untitled note', body });
      await renderCommandCenter();
      showToast('Note saved');
    } catch (error) {
      showToast(error.message || 'Note save failed');
    }
    return;
  }

  if (action === 'command-note-delete') {
    e.stopPropagation();
    const id = actionEl.dataset.noteId || '';
    if (!id) return;
    try {
      await postBackendAction('/api/notes/delete', { id });
      await renderCommandCenter();
      showToast('Note deleted');
    } catch (error) {
      showToast(error.message || 'Note delete failed');
    }
    return;
  }

  const card = actionEl.closest('.mission-card');

  // ---- Expand overflow chips ("+N more") ----
  if (action === 'expand-chips') {
    const overflowContainer = actionEl.parentElement.querySelector('.page-chips-overflow');
    if (overflowContainer) {
      overflowContainer.style.display = 'contents';
      actionEl.remove();
    }
    return;
  }

  // ---- Focus a specific tab ----
  if (action === 'focus-tab') {
    const tabUrl = actionEl.dataset.tabUrl;
    if (tabUrl) await focusTab(tabUrl);
    return;
  }

  // ---- Close a single tab ----
  if (action === 'close-single-tab') {
    e.stopPropagation(); // don't trigger parent chip's focus-tab
    const tabUrl = actionEl.dataset.tabUrl;
    if (!tabUrl) return;

    // Close the tab in Chrome directly
    const allTabs = await chrome.tabs.query({});
    const match   = allTabs.find(t => t.url === tabUrl);
    if (match) await chrome.tabs.remove(match.id);
    await fetchOpenTabs();

    playCloseSound();

    // Animate the chip row out
    const chip = actionEl.closest('.page-chip');
    if (chip) {
      const rect = chip.getBoundingClientRect();
      shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);
      chip.style.transition = 'opacity 0.2s, transform 0.2s';
      chip.style.opacity    = '0';
      chip.style.transform  = 'scale(0.8)';
      setTimeout(() => {
        chip.remove();
        // If the card now has no tabs, remove it too
        const parentCard = document.querySelector('.mission-card:has(.mission-pages:empty)');
        if (parentCard) animateCardOut(parentCard);
        document.querySelectorAll('.mission-card').forEach(c => {
          if (c.querySelectorAll('.page-chip[data-action="focus-tab"]').length === 0) {
            animateCardOut(c);
          }
        });
      }, 200);
    }

    // Update footer
    const statTabs = document.getElementById('statTabs');
    if (statTabs) statTabs.textContent = openTabs.length;

    showToast('Tab closed');
    return;
  }

  // ---- Save a single tab for later (then close it) ----
  if (action === 'defer-single-tab') {
    e.stopPropagation();
    const tabUrl   = actionEl.dataset.tabUrl;
    const tabTitle = actionEl.dataset.tabTitle || tabUrl;
    if (!tabUrl) return;

    // Save to chrome.storage.local
    try {
      await saveTabForLater({ url: tabUrl, title: tabTitle });
    } catch (err) {
      console.error('[command-tab] Failed to save tab:', err);
      showToast('Failed to save tab');
      return;
    }

    // Close the tab in Chrome
    const allTabs = await chrome.tabs.query({});
    const match   = allTabs.find(t => t.url === tabUrl);
    if (match) await chrome.tabs.remove(match.id);
    await fetchOpenTabs();

    // Animate chip out
    const chip = actionEl.closest('.page-chip');
    if (chip) {
      chip.style.transition = 'opacity 0.2s, transform 0.2s';
      chip.style.opacity    = '0';
      chip.style.transform  = 'scale(0.8)';
      setTimeout(() => chip.remove(), 200);
    }

    showToast('Saved for later');
    await renderDeferredColumn();
    return;
  }

  // ---- Check off a saved tab (moves it to archive) ----
  if (action === 'check-deferred') {
    const id = actionEl.dataset.deferredId;
    if (!id) return;

    await checkOffSavedTab(id);

    // Animate: strikethrough first, then slide out
    const item = actionEl.closest('.deferred-item');
    if (item) {
      item.classList.add('checked');
      setTimeout(() => {
        item.classList.add('removing');
        setTimeout(() => {
          item.remove();
          renderDeferredColumn(); // refresh counts and archive
        }, 300);
      }, 800);
    }
    return;
  }

  // ---- Dismiss a saved tab (removes it entirely) ----
  if (action === 'dismiss-deferred') {
    const id = actionEl.dataset.deferredId;
    if (!id) return;

    await dismissSavedTab(id);

    const item = actionEl.closest('.deferred-item');
    if (item) {
      item.classList.add('removing');
      setTimeout(() => {
        item.remove();
        renderDeferredColumn();
      }, 300);
    }
    return;
  }

  // ---- Close all tabs in a domain group ----
  if (action === 'close-domain-tabs') {
    const domainId = actionEl.dataset.domainId;
    const group    = domainGroups.find(g => {
      return 'domain-' + g.domain.replace(/[^a-z0-9]/g, '-') === domainId;
    });
    if (!group) return;

    const urls      = group.tabs.map(t => t.url);
    // Landing pages and custom groups (whose domain key isn't a real hostname)
    // must use exact URL matching to avoid closing unrelated tabs
    const useExact  = group.domain === '__landing-pages__' || !!group.label;

    if (useExact) {
      await closeTabsExact(urls);
    } else {
      await closeTabsByUrls(urls);
    }

    if (card) {
      playCloseSound();
      animateCardOut(card);
    }

    // Remove from in-memory groups
    const idx = domainGroups.indexOf(group);
    if (idx !== -1) domainGroups.splice(idx, 1);

    const groupLabel = group.domain === '__landing-pages__' ? 'Homepages' : (group.label || friendlyDomain(group.domain));
    showToast(`Closed ${urls.length} tab${urls.length !== 1 ? 's' : ''} from ${groupLabel}`);

    const statTabs = document.getElementById('statTabs');
    if (statTabs) statTabs.textContent = openTabs.length;
    return;
  }

  // ---- Close duplicates, keep one copy ----
  if (action === 'dedup-keep-one') {
    const urlsEncoded = actionEl.dataset.dupeUrls || '';
    const urls = urlsEncoded.split(',').map(u => decodeURIComponent(u)).filter(Boolean);
    if (urls.length === 0) return;

    await closeDuplicateTabs(urls, true);
    playCloseSound();

    // Hide the dedup button
    actionEl.style.transition = 'opacity 0.2s';
    actionEl.style.opacity    = '0';
    setTimeout(() => actionEl.remove(), 200);

    // Remove dupe badges from the card
    if (card) {
      card.querySelectorAll('.chip-dupe-badge').forEach(b => {
        b.style.transition = 'opacity 0.2s';
        b.style.opacity    = '0';
        setTimeout(() => b.remove(), 200);
      });
      card.querySelectorAll('.open-tabs-badge').forEach(badge => {
        if (badge.textContent.includes('duplicate')) {
          badge.style.transition = 'opacity 0.2s';
          badge.style.opacity    = '0';
          setTimeout(() => badge.remove(), 200);
        }
      });
      card.classList.remove('has-amber-bar');
      card.classList.add('has-neutral-bar');
    }

    showToast('Closed duplicates, kept one copy each');
    return;
  }

  // ---- Close ALL open tabs ----
  if (action === 'close-all-open-tabs') {
    const allUrls = openTabs
      .filter(t => t.url && !t.url.startsWith('chrome') && !t.url.startsWith('about:'))
      .map(t => t.url);
    await closeTabsByUrls(allUrls);
    playCloseSound();

    document.querySelectorAll('#openTabsMissions .mission-card').forEach(c => {
      shootConfetti(
        c.getBoundingClientRect().left + c.offsetWidth / 2,
        c.getBoundingClientRect().top  + c.offsetHeight / 2
      );
      animateCardOut(c);
    });

    showToast('All tabs closed. Fresh start.');
    return;
  }
});

document.addEventListener('submit', async (e) => {
  const form = e.target.closest('[data-action="command-task-add"]');
  if (!form) return;
  e.preventDefault();

  const titleInput = form.querySelector('[data-role="command-task-title"]');
  const detailInput = form.querySelector('[data-role="command-task-detail"]');
  const title = titleInput?.value.trim() || '';
  const detail = detailInput?.value.trim() || '';
  if (!title) {
    showToast('Write the task first');
    titleInput?.focus();
    return;
  }

  try {
    await postBackendAction('/api/tasks/add', { title, detail });
    if (titleInput) titleInput.value = '';
    if (detailInput) detailInput.value = '';
    await renderCommandCenter();
    showToast('Task added');
  } catch (error) {
    showToast(error.message || 'Task add failed');
  }
});

document.addEventListener('submit', async (e) => {
  const form = e.target.closest('[data-action="command-gratitude-save"]');
  if (!form) return;
  e.preventDefault();
  const input = form.querySelector('[data-role="command-gratitude-text"]');
  const text = input?.value.trim() || '';
  if (!text) {
    showToast('Write gratitude first');
    input?.focus();
    return;
  }
  try {
    await postBackendAction('/api/gratitude', { text });
    if (input) input.value = '';
    await renderCommandCenter();
    showToast('Gratitude saved');
  } catch (error) {
    showToast(error.message || 'Gratitude save failed');
  }
});

document.addEventListener('submit', async (e) => {
  const form = e.target.closest('[data-action="command-daily-shot-save"]');
  if (!form) return;
  e.preventDefault();
  const input = form.querySelector('[data-role="command-daily-shot-text"]');
  const text = input?.value.trim() || '';
  if (!text) {
    showToast('Write the shot first');
    input?.focus();
    return;
  }
  try {
    await postBackendAction('/api/daily-shot/log', { text });
    if (input) input.value = '';
    await renderCommandCenter();
    showToast('Daily shot saved');
  } catch (error) {
    showToast(error.message || 'Daily shot save failed');
  }
});

document.addEventListener('submit', async (e) => {
  const form = e.target.closest('[data-action="command-memory-search"]');
  if (!form) return;
  e.preventDefault();
  const input = form.querySelector('[data-role="command-memory-query"]');
  const query = input?.value.trim() || '';
  const resultsEl = form.parentElement?.querySelector('[data-role="command-memory-results"]');
  if (!query) {
    showToast('Write a search first');
    input?.focus();
    return;
  }
  if (resultsEl) resultsEl.innerHTML = '<div class="command-empty">Searching...</div>';
  try {
    const endpoint = `${connectorBaseUrl()}/api/memory/search?q=${encodeURIComponent(query)}&limit=6`;
    const res = await fetch(endpoint, { cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error || `Search returned ${res.status}`);
    const rows = (Array.isArray(data.results) ? data.results : []).slice(0, 6).map(result => `
      <div class="command-review-row">
        <div class="command-review-copy">
          <span>${escapeHtml(result.title || result.path_rel || 'Result')}</span>
          <small>${escapeHtml(result.snippet || result.path_rel || '')}</small>
        </div>
        ${result.path_abs ? `<button class="command-task-mini" data-action="command-memory-open" data-path="${escapeHtml(result.path_abs)}" type="button">Open</button>` : ''}
      </div>`).join('');
    if (resultsEl) resultsEl.innerHTML = rows || '<div class="command-empty">No results.</div>';
  } catch (error) {
    if (resultsEl) resultsEl.innerHTML = `<div class="command-error">${escapeHtml(error.message || 'Search failed')}</div>`;
    showToast(error.message || 'Search failed');
  }
});

document.addEventListener('submit', async (e) => {
  const form = e.target.closest('[data-action="command-settings-save"]');
  if (!form) return;
  e.preventDefault();
  const input = form.querySelector('[data-role="command-settings-url"]');
  const value = (input?.value || '').trim().replace(/\/$/, '');
  const codexPathInput = form.querySelector('[data-role="command-settings-codex-path"]');
  const codexPath = (codexPathInput?.value || '').trim();
  if (!value) {
    localStorage.removeItem(CONNECTOR_URL_STORAGE_KEY);
  } else {
    localStorage.setItem(CONNECTOR_URL_STORAGE_KEY, value);
  }
  if (!codexPath) {
    localStorage.removeItem(CODEX_PATH_STORAGE_KEY);
  } else {
    localStorage.setItem(CODEX_PATH_STORAGE_KEY, codexPath);
  }
  const toggles = form.querySelectorAll('[data-role="command-connector-toggle"]');
  if (toggles.length) {
    const hidden = new Set();
    toggles.forEach(toggle => {
      if (!toggle.checked) hidden.add(String(toggle.dataset.connectorId));
    });
    setHiddenConnectors(hidden);
  }
  await renderCommandCenter();
  showToast('Connector settings saved');
});

document.addEventListener('input', (e) => {
  const input = e.target.closest('[data-role="command-review-search"]');
  if (!input) return;
  const card = input.closest('[data-review-card]');
  const query = input.value.trim().toLowerCase();
  card?.querySelectorAll('.command-review-row').forEach(row => {
    const haystack = row.dataset.reviewSearch || '';
    row.hidden = Boolean(query && !haystack.includes(query));
  });
});

// ---- Archive toggle — expand/collapse the archive section ----
document.addEventListener('click', (e) => {
  const toggle = e.target.closest('#archiveToggle');
  if (!toggle) return;

  toggle.classList.toggle('open');
  const body = document.getElementById('archiveBody');
  if (body) {
    body.style.display = body.style.display === 'none' ? 'block' : 'none';
  }
});

// ---- Archive search — filter archived items as user types ----
document.addEventListener('input', async (e) => {
  if (e.target.id !== 'archiveSearch') return;

  const q = e.target.value.trim().toLowerCase();
  const archiveList = document.getElementById('archiveList');
  if (!archiveList) return;

  try {
    const { archived } = await getSavedTabs();

    if (q.length < 2) {
      // Show all archived items
      archiveList.innerHTML = archived.map(item => renderArchiveItem(item)).join('');
      return;
    }

    // Filter by title or URL containing the query string
    const results = archived.filter(item =>
      (item.title || '').toLowerCase().includes(q) ||
      (item.url  || '').toLowerCase().includes(q)
    );

    archiveList.innerHTML = results.map(item => renderArchiveItem(item)).join('')
      || '<div style="font-size:12px;color:var(--muted);padding:8px 0">No results</div>';
  } catch (err) {
    console.warn('[command-tab] Archive search failed:', err);
  }
});


/* ----------------------------------------------------------------
   INITIALIZE
   ---------------------------------------------------------------- */
renderDashboard();
