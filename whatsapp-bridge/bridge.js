'use strict';

/**
 * Command Tab WhatsApp Bridge — Baileys (read-only, no browser).
 *
 * Productization track. Speaks the WhatsApp multi-device WebSocket protocol via
 * Baileys, so there is no headless Chromium (no "detached Frame" failures, far
 * less memory). It implements the same local HTTP contract as the Chromium
 * bridge, so Command Tab can read from either interchangeably:
 *
 *   GET  /health
 *   GET  /chats
 *   GET  /messages?chat=JID&days=3&limit=100
 *   GET  /digest?days=7&max_chats=25&msgs_per_chat=15
 *
 * Read-only by design: it never sends. Incoming messages are stored in memory
 * for the digest only. Run:  npm install && npm start  → scan the QR once.
 *
 * Default port is 8003 so it can run ALONGSIDE the Chromium bridge (8002) for
 * side-by-side comparison.
 */

const baileys = require('@whiskeysockets/baileys');
const makeWASocket = baileys.makeWASocket || baileys.default;
const { useMultiFileAuthState, DisconnectReason } = baileys;
const qrcode = require('qrcode-terminal');
const http = require('http');
const path = require('path');

const HOST = '127.0.0.1';
const PORT = parseInt(process.env.BRIDGE_PORT || '8003', 10);
const AUTH_DIR = process.env.WHATSAPP_AUTH_DIR || path.join(__dirname, 'auth_info');
const MAX_MSGS_PER_CHAT = 400;

// Baileys wants a logger with a child() method; keep it silent and dependency-free.
const noop = () => {};
const logger = { level: 'silent', trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop, child: () => logger };

// ─── In-memory store (built from Baileys events) ────────────────────────────
const chats = new Map();    // jid -> { id, name, isGroup, unread, t, lastMessage }
const messages = new Map(); // jid -> [{ fromMe, from, body, t }] sorted asc, capped
const contacts = new Map(); // jid -> display name
let ready = false;
let lastQR = null;

function isGroupJid(jid) { return String(jid).endsWith('@g.us'); }

function messageText(m) {
  const msg = (m && m.message) || {};
  if (msg.ephemeralMessage) return messageText({ message: msg.ephemeralMessage.message });
  if (msg.viewOnceMessageV2) return messageText({ message: msg.viewOnceMessageV2.message });
  if (msg.viewOnceMessage) return messageText({ message: msg.viewOnceMessage.message });
  return msg.conversation
    || (msg.extendedTextMessage && msg.extendedTextMessage.text)
    || (msg.imageMessage && msg.imageMessage.caption)
    || (msg.videoMessage && msg.videoMessage.caption)
    || (msg.documentMessage && msg.documentMessage.caption)
    || '';
}

function messageTs(m) {
  const t = m && m.messageTimestamp;
  if (t == null) return 0;
  if (typeof t === 'number') return t;
  if (typeof t === 'object' && typeof t.toNumber === 'function') return t.toNumber();
  return Number(t) || 0;
}

function nameForJid(jid) {
  const c = chats.get(jid);
  if (c && c.name) return c.name;
  if (contacts.get(jid)) return contacts.get(jid);
  return String(jid).replace(/@.*/, '');
}

function recordContact(c) {
  if (!c || !c.id) return;
  const name = c.name || c.notify || c.verifiedName;
  if (name) contacts.set(c.id, name);
}

function recordChat(c) {
  if (!c || !c.id) return;
  const prev = chats.get(c.id) || {};
  chats.set(c.id, {
    id: c.id,
    name: c.name || c.subject || prev.name || '',
    isGroup: isGroupJid(c.id),
    unread: typeof c.unreadCount === 'number' ? c.unreadCount : (prev.unread || 0),
    t: Number(c.conversationTimestamp || prev.t || 0),
    lastMessage: prev.lastMessage || null,
  });
}

function recordMessage(m) {
  const jid = m && m.key && m.key.remoteJid;
  if (!jid || jid === 'status@broadcast') return;
  const body = messageText(m);
  if (!body) return;
  const t = messageTs(m);
  const fromMe = Boolean(m.key.fromMe);
  const from = fromMe ? 'me' : (m.pushName || nameForJid(m.key.participant || jid));

  const arr = messages.get(jid) || [];
  arr.push({ fromMe, from, body, t });
  arr.sort((a, b) => a.t - b.t);
  if (arr.length > MAX_MSGS_PER_CHAT) arr.splice(0, arr.length - MAX_MSGS_PER_CHAT);
  messages.set(jid, arr);

  const c = chats.get(jid) || { id: jid, name: '', isGroup: isGroupJid(jid), unread: 0, t: 0 };
  c.t = Math.max(c.t || 0, t);
  c.lastMessage = body.slice(0, 120);
  chats.set(jid, c);
}

// ─── Connect ─────────────────────────────────────────────────────────────────
async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  // Use the current WhatsApp Web version; a stale one gets rejected (405).
  let version;
  try {
    ({ version } = await baileys.fetchLatestBaileysVersion());
    console.log(`Using WhatsApp Web version ${version.join('.')}`);
  } catch (_e) {
    console.log('Could not fetch latest WA version; using Baileys default.');
  }

  const start = () => {
    const sock = makeWASocket({
      auth: state,
      version,
      logger,
      browser: ['Command Tab', 'Chrome', '1.0'],
      markOnlineOnConnect: false, // read-only: don't steal presence from the phone
      syncFullHistory: true,      // pull more history for the digest
      getMessage: async () => undefined,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, qr, lastDisconnect } = update;
      if (qr) {
        lastQR = qr;
        console.log('\n📱 Scan this QR with WhatsApp → Settings → Linked Devices → Link a Device:\n');
        qrcode.generate(qr, { small: true });
      }
      if (connection === 'open') {
        ready = true;
        lastQR = null;
        console.log(`✓ Baileys bridge ready — http://${HOST}:${PORT}`);
      }
      if (connection === 'close') {
        ready = false;
        const err = lastDisconnect && lastDisconnect.error;
        const code = err && err.output && err.output.statusCode;
        const reason = (err && err.message) || 'unknown';
        if (code === DisconnectReason.loggedOut) {
          console.log(`Logged out. Delete ${AUTH_DIR} and restart to re-link.`);
        } else {
          console.log(`Connection closed (code=${code} reason="${reason}") — reconnecting in 3s...`);
          setTimeout(start, 3000); // backoff so we don't hammer on persistent failures
        }
      }
    });

    // History sync (bulk) + live events feed the same store.
    sock.ev.on('messaging-history.set', ({ chats: cs = [], contacts: ct = [], messages: ms = [] }) => {
      ct.forEach(recordContact);
      cs.forEach(recordChat);
      ms.forEach(recordMessage);
    });
    sock.ev.on('contacts.set', ({ contacts: cs = [] }) => cs.forEach(recordContact));
    sock.ev.on('contacts.upsert', (cs = []) => cs.forEach(recordContact));
    sock.ev.on('contacts.update', (cs = []) => cs.forEach(recordContact));
    sock.ev.on('chats.set', ({ chats: cs = [] }) => cs.forEach(recordChat));
    sock.ev.on('chats.upsert', (cs = []) => cs.forEach(recordChat));
    sock.ev.on('chats.update', (cs = []) => cs.forEach(recordChat));
    sock.ev.on('messages.upsert', ({ messages: ms = [] }) => ms.forEach(recordMessage));
  };

  start();
}

// ─── Local HTTP API (127.0.0.1 only) ────────────────────────────────────────
function sendJson(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function chatList() {
  return [...chats.values()].sort((a, b) => (b.t || 0) - (a.t || 0));
}

http.createServer((req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const p = url.pathname;

  if (req.method === 'GET' && p === '/health') {
    return sendJson(res, { service: 'whatsapp-bridge-baileys', ready, waiting_for_qr: Boolean(lastQR), chats: chats.size });
  }

  if (!ready) return sendJson(res, { error: 'WhatsApp client not ready yet (scan the QR)' }, 503);

  if (req.method === 'GET' && p === '/chats') {
    const result = chatList().slice(0, 60).map(c => ({
      id: c.id, name: c.name || nameForJid(c.id), isGroup: c.isGroup,
      unread: c.unread || 0, lastMessage: c.lastMessage || null, timestamp: c.t || null,
    }));
    return sendJson(res, result);
  }

  if (req.method === 'GET' && p === '/messages') {
    const chatId = url.searchParams.get('chat');
    const days = parseInt(url.searchParams.get('days') || '3', 10);
    const limit = parseInt(url.searchParams.get('limit') || '100', 10);
    if (!chatId) return sendJson(res, { error: 'chat param required' }, 400);
    const cutoff = (Date.now() / 1000) - (days * 86400);
    const recent = (messages.get(chatId) || [])
      .filter(m => m.t >= cutoff)
      .slice(-limit)
      .map(m => ({ fromMe: m.fromMe, from: m.from, body: m.body, timestamp: m.t, time: new Date(m.t * 1000).toLocaleString() }));
    return sendJson(res, { chat: nameForJid(chatId), id: chatId, messages: recent });
  }

  if (req.method === 'GET' && p === '/digest') {
    const days = parseInt(url.searchParams.get('days') || '7', 10);
    const maxChats = parseInt(url.searchParams.get('max_chats') || '25', 10);
    const msgsPerChat = parseInt(url.searchParams.get('msgs_per_chat') || '15', 10);
    const cutoff = (Date.now() / 1000) - (days * 86400);
    const result = [];
    for (const c of chatList()) {
      if (c.isGroup || (c.t || 0) < cutoff) continue;
      const recent = (messages.get(c.id) || [])
        .filter(m => m.t >= cutoff)
        .slice(-msgsPerChat)
        .map(m => ({ fromMe: m.fromMe, from: m.from, body: m.body.slice(0, 200), time: new Date(m.t * 1000).toLocaleString() }));
      if (recent.length) result.push({ name: c.name || nameForJid(c.id), id: c.id, unread: c.unread || 0, messages: recent });
      if (result.length >= maxChats) break;
    }
    return sendJson(res, { days, generated: new Date().toISOString(), chats: result });
  }

  sendJson(res, { error: 'Not found' }, 404);
}).listen(PORT, HOST, () => {
  console.log(`Command Tab WhatsApp bridge (Baileys) listening on http://${HOST}:${PORT}`);
  console.log('Starting WhatsApp connection... (scan the QR on first run)');
});

connect().catch(err => {
  console.error('Failed to start Baileys:', err && err.message ? err.message : err);
  process.exit(1);
});
