'use strict';

/**
 * Native Google connectors for Command Tab (read-only).
 *
 * Standalone OAuth connectors that do NOT depend on the external Hamilton
 * backend. Intentionally dependency-free: Node's built-in fetch (Node 18+),
 * crypto, fs, and path only.
 *
 * Privacy rules this module follows:
 * - OAuth client id/secret come from the user's own Google Cloud project,
 *   supplied via env, a gitignored credentials file, or embedded in an
 *   existing google-auth-format token file. Nothing is hardcoded.
 * - Tokens are written only into the gitignored context dir. We never write
 *   back to credential files owned by other tools.
 * - Every failure is surfaced. We never present cached or fake data as live.
 *
 * Services: read-only Google Calendar and read-only Gmail. Each has its own
 * scope and its own token file so existing per-scope tokens can be reused.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HOST = process.env.COMMAND_TAB_HOST || '127.0.0.1';
const PORT = Number.parseInt(process.env.COMMAND_TAB_PORT || '8733', 10);
const CONTEXT_DIR = process.env.COMMAND_TAB_CONTEXT_DIR || path.join(process.cwd(), 'command-tab-context');

const REDIRECT_URI = `http://${HOST}:${PORT}/api/google/callback`;
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

const SERVICES = {
  calendar: { scope: 'https://www.googleapis.com/auth/calendar.readonly' },
  gmail: { scope: 'https://www.googleapis.com/auth/gmail.readonly' },
};

// Accepted short scope aliases on the connect route.
const SCOPE_ALIASES = {
  'calendar.readonly': SERVICES.calendar.scope,
  'calendar': SERVICES.calendar.scope,
  'gmail.readonly': SERVICES.gmail.scope,
  'gmail': SERVICES.gmail.scope,
};

// In-memory pending-auth state (state -> { verifier, scope, service, created }).
const pendingAuth = new Map();

function tokenFilePath(service) {
  const envKey = `COMMAND_TAB_GOOGLE_${service.toUpperCase()}_TOKEN_FILE`;
  if (process.env[envKey]) return process.env[envKey];
  // Legacy single-token override applies to calendar only.
  if (service === 'calendar' && process.env.COMMAND_TAB_GOOGLE_TOKEN_FILE) {
    return process.env.COMMAND_TAB_GOOGLE_TOKEN_FILE;
  }
  return path.join(CONTEXT_DIR, `google-${service}-token.json`);
}

function credentialsFilePath() {
  return process.env.COMMAND_TAB_GOOGLE_CREDENTIALS || path.join(CONTEXT_DIR, 'google-credentials.json');
}

function calendarId() {
  return process.env.COMMAND_TAB_GOOGLE_CALENDAR_ID || 'primary';
}

function gmailQuery() {
  return process.env.COMMAND_TAB_GMAIL_QUERY || 'in:inbox is:unread newer_than:14d';
}

function serviceForScope(scope) {
  for (const [name, def] of Object.entries(SERVICES)) {
    if (def.scope === scope) return name;
  }
  return 'calendar';
}

/**
 * Resolve OAuth client credentials from env first, then a credentials file in
 * the Google-downloaded shape ({ installed } / { web }), then any client
 * id/secret embedded in an existing token file. Returns null if unconfigured.
 */
function loadClientConfig(rawToken) {
  const envId = process.env.COMMAND_TAB_GOOGLE_CLIENT_ID;
  const envSecret = process.env.COMMAND_TAB_GOOGLE_CLIENT_SECRET;
  if (envId && envSecret) {
    return { client_id: envId, client_secret: envSecret, source: 'env' };
  }

  const file = credentialsFilePath();
  if (fs.existsSync(file)) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      throw new Error(`Google credentials file is not valid JSON (${file}): ${error.message}`);
    }
    const block = parsed.installed || parsed.web || parsed;
    if (!block.client_id || !block.client_secret) {
      throw new Error(`Google credentials file is missing client_id/client_secret (${file}).`);
    }
    return { client_id: block.client_id, client_secret: block.client_secret, source: file };
  }

  if (rawToken && rawToken.client_id && rawToken.client_secret) {
    return { client_id: rawToken.client_id, client_secret: rawToken.client_secret, source: 'token' };
  }
  return null;
}

function readTokenFile(service) {
  const file = tokenFilePath(service);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * Normalize either Command Tab's own token shape or the google-auth Python
 * token shape ({ token, expiry, scopes, ... }) into a common view.
 */
function normalizeToken(raw) {
  if (!raw) return null;
  let expiresAt = 0;
  if (raw.expires_at) {
    expiresAt = Number(raw.expires_at);
  } else if (raw.expiry) {
    const parsed = Date.parse(raw.expiry);
    if (!Number.isNaN(parsed)) expiresAt = parsed;
  }
  const scope = raw.scope || (Array.isArray(raw.scopes) ? raw.scopes.join(' ') : '');
  return {
    refresh_token: raw.refresh_token || '',
    access_token: raw.access_token || raw.token || '',
    expires_at: expiresAt,
    scope,
  };
}

function writeTokenFile(service, raw) {
  const file = tokenFilePath(service);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
}

function base64url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function resolveScope(scopeParam) {
  const raw = String(scopeParam || 'calendar.readonly').trim();
  if (raw.startsWith('https://')) return raw;
  return SCOPE_ALIASES[raw] || SCOPE_ALIASES['calendar.readonly'];
}

function cleanupPendingAuth() {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [state, entry] of pendingAuth) {
    if (entry.created < cutoff) pendingAuth.delete(state);
  }
}

/** Build the Google consent URL (PKCE, loopback redirect). Returns { url, state }. */
function buildConsentUrl(scopeParam) {
  const client = loadClientConfig();
  if (!client) throw new Error('No Google client configured.');
  cleanupPendingAuth();

  const scope = resolveScope(scopeParam);
  const service = serviceForScope(scope);
  const state = base64url(crypto.randomBytes(24));
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  pendingAuth.set(state, { verifier, scope, service, created: Date.now() });

  const params = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  });
  return { url: `${AUTH_ENDPOINT}?${params.toString()}`, state };
}

async function postToken(body) {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  const text = await res.text();
  let data = {};
  if (text.trim()) {
    try {
      data = JSON.parse(text);
    } catch (_error) {
      throw new Error(`Google token endpoint returned non-JSON (${res.status}): ${text.slice(0, 180)}`);
    }
  }
  if (!res.ok || data.error) {
    throw new Error(data.error_description || data.error || `Google token endpoint returned ${res.status}`);
  }
  return data;
}

/** Exchange an authorization code for tokens and persist them for the service. */
async function exchangeCode(code, state) {
  const entry = pendingAuth.get(state);
  if (!entry) throw new Error('Unknown or expired auth state. Start the connect flow again.');
  pendingAuth.delete(state);

  const client = loadClientConfig();
  if (!client) throw new Error('No Google client configured.');

  const data = await postToken({
    client_id: client.client_id,
    client_secret: client.client_secret,
    code,
    code_verifier: entry.verifier,
    grant_type: 'authorization_code',
    redirect_uri: REDIRECT_URI,
  });

  if (!data.refresh_token) {
    throw new Error('Google did not return a refresh token. Remove prior access at myaccount.google.com/permissions and connect again.');
  }

  const token = {
    refresh_token: data.refresh_token,
    access_token: data.access_token || '',
    token: data.access_token || '',
    expires_at: data.expires_in ? Date.now() + (Number(data.expires_in) - 60) * 1000 : 0,
    scope: data.scope || entry.scope,
    token_type: data.token_type || 'Bearer',
    client_id: client.client_id,
    client_secret: client.client_secret,
    obtained_at: new Date().toISOString(),
  };
  writeTokenFile(entry.service, token);
  return token;
}

/** Return a valid access token for a service, refreshing as needed. */
async function getAccessToken(service) {
  const raw = readTokenFile(service);
  if (!raw) throw new Error(`Google ${service} is not connected yet. Use the connect action to authorize.`);
  const client = loadClientConfig(raw);
  if (!client) throw new Error('Google connector is not configured. Add OAuth client credentials.');
  const norm = normalizeToken(raw);
  if (!norm.refresh_token) {
    throw new Error(`Google ${service} token has no refresh token. Reconnect to grant offline access.`);
  }
  if (norm.access_token && norm.expires_at && norm.expires_at > Date.now()) {
    return norm.access_token;
  }

  const data = await postToken({
    client_id: client.client_id,
    client_secret: client.client_secret,
    refresh_token: norm.refresh_token,
    grant_type: 'refresh_token',
  });
  const accessToken = data.access_token || '';
  // Merge into the existing raw object so we never drop embedded fields
  // (client_id/secret/token_uri) when the token came from another tool.
  raw.access_token = accessToken;
  raw.token = accessToken;
  raw.expires_at = data.expires_in ? Date.now() + (Number(data.expires_in) - 60) * 1000 : 0;
  if (data.expires_in) raw.expiry = new Date(Date.now() + Number(data.expires_in) * 1000).toISOString();
  if (data.scope) raw.scope = data.scope;
  raw.refreshed_at = new Date().toISOString();
  writeTokenFile(service, raw);
  return accessToken;
}

async function googleFetch(accessToken, apiUrl) {
  const res = await fetch(apiUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
  const text = await res.text();
  let data = {};
  if (text.trim()) {
    try {
      data = JSON.parse(text);
    } catch (_error) {
      throw new Error(`Google API returned non-JSON (${res.status}): ${text.slice(0, 180)}`);
    }
  }
  if (!res.ok || data.error) {
    const detail = data.error?.message || data.error_description || data.error || `Google API returned ${res.status}`;
    throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
  }
  return data;
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

function formatEventTime(event) {
  const start = event.start || {};
  if (start.date && !start.dateTime) {
    try {
      const label = new Date(`${start.date}T00:00:00`).toLocaleDateString(undefined, {
        weekday: 'short', month: 'short', day: 'numeric',
      });
      return `${label} · all day`;
    } catch (_error) {
      return `${start.date} · all day`;
    }
  }
  if (start.dateTime) {
    try {
      return new Date(start.dateTime).toLocaleString(undefined, {
        weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
      });
    } catch (_error) {
      return start.dateTime;
    }
  }
  return '';
}

async function listUpcomingEvents({ hours = 12, max = 8 } = {}) {
  const accessToken = await getAccessToken('calendar');
  const now = new Date();
  const params = new URLSearchParams({
    timeMin: now.toISOString(),
    timeMax: new Date(now.getTime() + Math.max(1, hours) * 3600 * 1000).toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: String(Math.max(1, Math.min(50, max * 2))),
  });
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId())}/events?${params.toString()}`;
  const data = await googleFetch(accessToken, url);
  const events = Array.isArray(data.items) ? data.items : [];
  return events
    .filter(event => event.status !== 'cancelled')
    .slice(0, max)
    .map((event, index) => ({
      id: event.id || `calendar-${index + 1}`,
      title: String(event.summary || '(no title)').slice(0, 160),
      detail: [formatEventTime(event), event.location || ''].filter(Boolean).join(' · ').slice(0, 240),
    }));
}

async function readCalendarConnector(now, { hours = 12 } = {}) {
  const base = { id: 'calendar', label: 'Calendar', kind: 'oauth', generated_at: now };
  const connectAction = { label: 'Connect Google Calendar', url: `http://${HOST}:${PORT}/api/google/connect?scope=calendar.readonly` };

  const token = readTokenFile('calendar');
  let client;
  try {
    client = loadClientConfig(token);
  } catch (error) {
    return { ...base, status: 'error', source: 'none', error: error.message, items: [], actions: [connectAction] };
  }
  if (!client) {
    return {
      ...base,
      status: 'disconnected',
      source: 'none',
      error: `Not configured. Add a Google OAuth client via COMMAND_TAB_GOOGLE_CLIENT_ID/SECRET or ${credentialsFilePath()}, then click Connect.`,
      items: [],
      actions: [],
    };
  }
  if (!token || !normalizeToken(token).refresh_token) {
    return {
      ...base,
      status: 'disconnected',
      source: 'none',
      error: 'Google client configured but Calendar is not authorized yet. Click Connect to grant read-only access.',
      items: [],
      actions: [connectAction],
    };
  }

  try {
    const items = await listUpcomingEvents({ hours });
    return {
      ...base,
      status: 'ok',
      source: 'live',
      error: null,
      summary: items.length ? `${items.length} upcoming (next ${hours}h)` : `No events in the next ${hours}h`,
      items,
      actions: [{ label: 'Refresh', command: 'refresh-command-center' }],
    };
  } catch (error) {
    return { ...base, status: 'error', source: 'live', error: `Calendar API error: ${error.message}`, items: [], actions: [connectAction] };
  }
}

// ---------------------------------------------------------------------------
// Gmail
// ---------------------------------------------------------------------------

function header(payload, name) {
  const headers = (payload && Array.isArray(payload.headers)) ? payload.headers : [];
  const found = headers.find(h => String(h.name || '').toLowerCase() === name.toLowerCase());
  return found ? String(found.value || '') : '';
}

function decodeSnippet(text) {
  // Gmail snippets HTML-encode a few entities; decode the common ones.
  return String(text || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
}

async function listRecentMail({ query, max = 8 } = {}) {
  const accessToken = await getAccessToken('gmail');
  const q = query || gmailQuery();
  const listUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${Math.max(1, Math.min(25, max))}&q=${encodeURIComponent(q)}`;
  const list = await googleFetch(accessToken, listUrl);
  const messages = Array.isArray(list.messages) ? list.messages : [];

  const items = [];
  for (const message of messages.slice(0, max)) {
    const detailUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${message.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`;
    const detail = await googleFetch(accessToken, detailUrl);
    const subject = header(detail.payload, 'Subject') || '(no subject)';
    const from = header(detail.payload, 'From');
    const date = header(detail.payload, 'Date');
    const snippet = decodeSnippet(detail.snippet);
    items.push({
      id: message.id,
      title: subject.slice(0, 160),
      sender: from.slice(0, 160),
      detail: [from, snippet].filter(Boolean).join(' · ').slice(0, 240),
      body: snippet.slice(0, 600),
      timestamp: date,
    });
  }
  return items;
}

async function readGmailConnector(now, { query, max = 8 } = {}) {
  const base = { id: 'gmail', label: 'Gmail', kind: 'oauth', generated_at: now };
  const connectAction = { label: 'Connect Gmail', url: `http://${HOST}:${PORT}/api/google/connect?scope=gmail.readonly` };

  const token = readTokenFile('gmail');
  let client;
  try {
    client = loadClientConfig(token);
  } catch (error) {
    return { ...base, status: 'error', source: 'none', error: error.message, items: [], actions: [connectAction] };
  }
  if (!client) {
    return {
      ...base,
      status: 'disconnected',
      source: 'none',
      error: `Not configured. Add a Google OAuth client via COMMAND_TAB_GOOGLE_CLIENT_ID/SECRET or ${credentialsFilePath()}, then click Connect.`,
      items: [],
      actions: [],
    };
  }
  if (!token || !normalizeToken(token).refresh_token) {
    return {
      ...base,
      status: 'disconnected',
      source: 'none',
      error: 'Google client configured but Gmail is not authorized yet. Click Connect to grant read-only access.',
      items: [],
      actions: [connectAction],
    };
  }

  try {
    const items = await listRecentMail({ query, max });
    return {
      ...base,
      status: 'ok',
      source: 'live',
      error: null,
      summary: `${items.length} message${items.length === 1 ? '' : 's'} · ${gmailQuery()}`,
      items,
      actions: [{ label: 'Refresh', command: 'refresh-command-center' }],
    };
  } catch (error) {
    return { ...base, status: 'error', source: 'live', error: `Gmail API error: ${error.message}`, items: [], actions: [connectAction] };
  }
}

// ---------------------------------------------------------------------------
// OAuth route handlers (served by the connector server)
// ---------------------------------------------------------------------------

function htmlPage(title, message, accent = '#1a7f37') {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0f1115;color:#e8eaed;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.box{max-width:440px;padding:32px;text-align:center}h1{font-size:20px;margin:0 0 12px;color:${accent}}p{line-height:1.6;color:#b6b9c0}</style></head>
<body><div class="box"><h1>${title}</h1><p>${message}</p></div></body></html>`;
}

function sendHtml(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

/** GET /api/google/connect — start the consent flow (redirects to Google). */
function handleConnect(req, res, url) {
  try {
    const { url: consentUrl } = buildConsentUrl(url.searchParams.get('scope'));
    res.writeHead(302, { Location: consentUrl, 'Cache-Control': 'no-store' });
    res.end();
  } catch (error) {
    sendHtml(res, 400, htmlPage('Cannot connect Google', `${error.message}`, '#d1242f'));
  }
}

/** GET /api/google/callback — handle Google's redirect, exchange the code. */
async function handleCallback(req, res, url) {
  const error = url.searchParams.get('error');
  if (error) {
    sendHtml(res, 400, htmlPage('Google authorization failed', `Google returned: ${error}. You can close this tab and try again.`, '#d1242f'));
    return;
  }
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) {
    sendHtml(res, 400, htmlPage('Google authorization failed', 'Missing code or state. Close this tab and start the connect flow again.', '#d1242f'));
    return;
  }
  try {
    await exchangeCode(code, state);
    sendHtml(res, 200, htmlPage('Google connected', 'You can close this tab and refresh your Command Tab new tab.'));
  } catch (err) {
    sendHtml(res, 400, htmlPage('Google authorization failed', `${err.message} You can close this tab and try again.`, '#d1242f'));
  }
}

module.exports = {
  isConfigured: () => Boolean(loadClientConfig()),
  readCalendarConnector,
  readGmailConnector,
  listUpcomingEvents,
  listRecentMail,
  handleConnect,
  handleCallback,
  tokenFilePath,
  credentialsFilePath,
};
