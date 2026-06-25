'use strict';

/**
 * Command Tab — WhatsApp summarizer backend (deploys to Railway).
 *
 * Stateless and no-retention: it receives a digest of recent 1:1 messages,
 * summarizes each thread with a cheap model via OpenRouter, and returns
 * structured tags. It stores NOTHING — message text is summarized and dropped.
 *
 * POST /summarize   body: { chats: [{ id, name, unread, messages:[{fromMe,from,body,time}] }] }
 *                   auth: Authorization: Bearer <SUMMARIZER_TOKEN> (if configured)
 * GET  /health
 *
 * Env: OPENROUTER_API_KEY (required), SUMMARIZER_TOKEN (optional auth),
 *      SUMMARIZER_MODEL (default openai/gpt-oss-120b), PORT.
 */

const http = require('http');

const PORT = parseInt(process.env.PORT || '8090', 10);
const MODEL = process.env.SUMMARIZER_MODEL || 'openai/gpt-oss-120b';
const TOKEN = process.env.SUMMARIZER_TOKEN || '';
// OpenAI-compatible endpoint. Defaults to OpenRouter (hosted); point at a local
// model for fully on-device summarization (nothing leaves the machine):
//   Ollama:    LLM_BASE_URL=http://127.0.0.1:11434/v1  SUMMARIZER_MODEL=qwen2.5:3b
//   llama.cpp: LLM_BASE_URL=http://127.0.0.1:8080/v1   (llama-server)
const LLM_BASE_URL = (process.env.LLM_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
const LLM_API_KEY = process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY || '';
const COMPLETIONS_URL = `${LLM_BASE_URL}/chat/completions`;
const IS_LOCAL = /127\.0\.0\.1|localhost/.test(LLM_BASE_URL);
const MAX_CONCURRENCY = IS_LOCAL ? 2 : 4; // local model: don't oversubscribe
const MAX_CHATS = 40;

const SYSTEM = [
  'You triage one WhatsApp 1:1 conversation for a busy person ("the user").',
  'Decide whether the user still owes a reply, and capture what matters.',
  'Return ONLY valid JSON (no prose) with exactly these keys:',
  '{',
  '  "summary": string (<= 45 words, what is going on now),',
  '  "structured": {',
  '    "action_state": "reply_needed" | "review_or_reply" | "no_action",',
  '    "action_label": short string e.g. "Reply needed" | "Waiting on them" | "Review / maybe reply" | "No action",',
  '    "pending_from_you": string or null (what the user still needs to send/answer),',
  '    "pending_from_them": string or null (what the other person still owes),',
  '    "you_said": string (gist of the user\'s last point),',
  '    "they_said": string (gist of the other person\'s last point),',
  '    "top_topics": array of <= 4 short strings,',
  '    "suggestion": string (one concrete next step, or ""),',
  '    "confidence": number 0..1',
  '  }',
  '}',
  'If the last message is from the other person and asks/expects something, action_state is usually "reply_needed".',
  'If the user already replied and is waiting, set pending_from_them and action_label "Waiting on them".',
].join('\n');

function fallbackStructured(extra) {
  return Object.assign({
    action_state: 'review_or_reply',
    action_label: 'Review / maybe reply',
    pending_from_you: null,
    pending_from_them: null,
    you_said: '',
    they_said: '',
    top_topics: [],
    suggestion: '',
    confidence: 0,
  }, extra || {});
}

async function summarizeChat(chat) {
  const base = { id: chat.id, name: chat.name, unread: chat.unread || 0, messages: Array.isArray(chat.messages) ? chat.messages : [] };
  const lines = base.messages.slice(-25)
    .map((m) => `${m.fromMe ? 'Me' : (m.from || 'Them')}: ${String(m.body || '').slice(0, 300)}`)
    .join('\n');

  if (!lines.trim()) {
    return Object.assign(base, { summary: 'No recent messages.', structured: fallbackStructured({ action_state: 'no_action', action_label: 'No action' }) });
  }
  if (!IS_LOCAL && !LLM_API_KEY) {
    // Remote endpoint with no key: honest failure, no fake summary.
    return Object.assign(base, { summary: null, structured: fallbackStructured(), summary_error: 'No LLM_API_KEY/OPENROUTER_API_KEY set on the backend' });
  }

  const headers = { 'Content-Type': 'application/json', 'X-Title': 'Command Tab WhatsApp' };
  if (LLM_API_KEY) headers.Authorization = `Bearer ${LLM_API_KEY}`;
  const user = `Chat with: ${chat.name || 'Unknown'}\nRecent messages (oldest first):\n${lines}`;
  try {
    const res = await fetch(COMPLETIONS_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }],
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data.error && data.error.message) || `LLM endpoint ${res.status}`);
    const content = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '{}';
    const parsed = JSON.parse(content);
    return Object.assign(base, {
      summary: String(parsed.summary || ''),
      structured: fallbackStructured(parsed.structured || {}),
    });
  } catch (e) {
    return Object.assign(base, { summary: null, structured: fallbackStructured(), summary_error: String((e && e.message) || e) });
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); }
  });
  await Promise.all(workers);
  return out;
}

function json(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, {});

  if (req.method === 'GET' && req.url === '/health') {
    return json(res, 200, { status: 'ok', model: MODEL, base_url: LLM_BASE_URL, local: IS_LOCAL, has_key: Boolean(LLM_API_KEY), auth: Boolean(TOKEN) });
  }

  if (req.method === 'POST' && req.url === '/summarize') {
    if (TOKEN) {
      const auth = req.headers.authorization || '';
      if (auth !== `Bearer ${TOKEN}`) return json(res, 401, { error: 'unauthorized' });
    }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 5_000_000) req.destroy(); });
    req.on('end', async () => {
      let payload;
      try { payload = JSON.parse(body || '{}'); } catch { return json(res, 400, { error: 'invalid JSON' }); }
      const chats = (Array.isArray(payload.chats) ? payload.chats : []).slice(0, MAX_CHATS);
      if (!chats.length) return json(res, 200, { summarized: true, generated: new Date().toISOString(), chats: [] });
      try {
        const out = await mapLimit(chats, MAX_CONCURRENCY, summarizeChat);
        // No retention: nothing is written to disk; only the result is returned.
        console.log(`summarized ${out.length} chats with ${MODEL}`);
        return json(res, 200, { summarized: true, generated: new Date().toISOString(), model: MODEL, chats: out });
      } catch (e) {
        return json(res, 500, { error: String((e && e.message) || e) });
      }
    });
    return;
  }

  json(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  console.log(`Summarizer backend listening on :${PORT} (model ${MODEL}, key ${OPENROUTER_KEY ? 'set' : 'MISSING'})`);
});
