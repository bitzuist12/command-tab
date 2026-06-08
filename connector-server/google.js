'use strict';

/**
 * Native Google connector for Command Tab.
 *
 * This is a real, standalone OAuth connector. It does NOT depend on the
 * external Hamilton backend. It is intentionally dependency-free: it uses
 * Node's built-in fetch (Node 18+), crypto, fs, and path only.
 *
 * Privacy rules this module follows:
 * - OAuth client id/secret come from the user's own Google Cloud project,
 *   supplied via env vars or a gitignored credentials file. Nothing is
 *   hardcoded into the public repo.
 * - Refresh/access tokens are written only into the gitignored context dir.
 * - Every failure is surfaced. We never present cached or fake data as live.
 *
 * Current scope: read-only Google Calendar. The OAuth plumbing is written so
 * Gmail (or other read-only Google scopes) can be added later.
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

// Short scope aliases the connect route accepts, mapped to full Google scopes.
const SCOPE_ALIASES = {
  'calendar.readonly': 'https://www.googleapis.com/auth/calendar.readonly',
  'calendar': 'https://www.googleapis.com/auth/calendar.readonly',
};

// In-memory pending-auth state (state -> { verifier, scope, created }).
// Cleared on use and expired after 10 minutes.
const pendingAuth = new Map();

function tokenFilePath() {
  return process.env.COMMAND_TAB_GOOGLE_TOKEN_FILE || path.join(CONTEXT_DIR, 'google-token.json');
}

function credentialsFilePath() {
  return process.env.COMMAND_TAB_GOOGLE_CREDENTIALS || path.join(CONTEXT_DIR, 'google-credentials.json');
}

function calendarId() {
  return process.env.COMMAND_TAB_GOOGLE_CALENDAR_ID || 'primary';
}

/**
 * Load OAuth client credentials from env first, then a credentials file in the
 * Google-downloaded shape ({ installed: {...} } or { web: {...} }), then any
 * client id/secret embedded in an existing token file (the google-auth Python
 * token format embeds them). Returns null if no client is configured.
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

  // Fall back to credentials embedded in the token file (google-auth format).
  const token = rawToken || readTokenFile();
  if (token && token.client_id && token.client_secret) {
    return { client_id: token.client_id, client_secret: token.client_secret, source: 'token' };
  }
  return null;
}

function isConfigured() {
  try {
    return Boolean(loadClientConfig());
  } catch (_error) {
    return true; // misconfigured but present; surface the error elsewhere
  }
}

/** Read the raw token file as-is (preserving any extra fields). */
function readTokenFile() {
  const file = tokenFilePath();
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

/** Write the raw token object back, preserving format and fields. */
function writeTokenFile(raw) {
  const file = tokenFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
}

function saveToken(token) {
  writeTokenFile(token);
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

/**
 * Build the Google consent URL for a loopback/desktop OAuth client using PKCE.
 * Returns { url, state }.
 */
function buildConsentUrl(scopeParam) {
  const client = loadClientConfig();
  if (!client) throw new Error('No Google client configured.');
  cleanupPendingAuth();

  const scope = resolveScope(scopeParam);
  const state = base64url(crypto.randomBytes(24));
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  pendingAuth.set(state, { verifier, scope, created: Date.now() });

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

/**
 * Exchange an authorization code for tokens and persist them.
 * Returns the saved token record.
 */
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
    expires_at: data.expires_in ? Date.now() + (Number(data.expires_in) - 60) * 1000 : 0,
    scope: data.scope || entry.scope,
    token_type: data.token_type || 'Bearer',
    obtained_at: new Date().toISOString(),
  };
  saveToken(token);
  return token;
}

/**
 * Return a valid access token, refreshing via the stored refresh token when
 * the cached access token is missing or expired. Persists refreshed tokens.
 */
async function getAccessToken() {
  const raw = readTokenFile();
  if (!raw) throw new Error('Google is not connected yet. Use the connect action to authorize.');
  const client = loadClientConfig(raw);
  if (!client) throw new Error('Google connector is not configured. Add OAuth client credentials.');
  const norm = normalizeToken(raw);
  if (!norm.refresh_token) {
    throw new Error('Google token has no refresh token. Reconnect to grant offline access.');
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
  const expiresAt = data.expires_in ? Date.now() + (Number(data.expires_in) - 60) * 1000 : 0;
  // Merge into the existing raw object so we never drop embedded fields
  // (client_id/secret/token_uri) when the token came from another tool.
  raw.access_token = accessToken;
  raw.token = accessToken;
  raw.expires_at = expiresAt;
  if (data.expires_in) raw.expiry = new Date(Date.now() + Number(data.expires_in) * 1000).toISOString();
  if (data.scope) raw.scope = data.scope;
  raw.refreshed_at = new Date().toISOString();
  writeTokenFile(raw);
  return accessToken;
}

async function googleGet(apiUrl) {
  const accessToken = await getAccessToken();
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

function formatEventTime(event) {
  const start = event.start || {};
  if (start.date && !start.dateTime) {
    // All-day event.
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
  const now = new Date();
  const timeMin = now.toISOString();
  const timeMax = new Date(now.getTime() + Math.max(1, hours) * 3600 * 1000).toISOString();
  const params = new URLSearchParams({
    timeMin,
    timeMax,
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: String(Math.max(1, Math.min(50, max * 2))),
  });
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId())}/events?${params.toString()}`;
  const data = await googleGet(url);
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

/**
 * Build the Calendar connector card for /api/summary. Honors the contract:
 * disconnected when no client/token, error on live-call failure, ok otherwise.
 */
async function readCalendarConnector(now, { hours = 12 } = {}) {
  const base = { id: 'calendar', label: 'Calendar', kind: 'oauth', generated_at: now };
  const connectAction = { label: 'Connect Google Calendar', url: `http://${HOST}:${PORT}/api/google/connect?scope=calendar.readonly` };

  const token = readTokenFile();
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
      error: 'Google client configured but not authorized yet. Click Connect to grant read-only Calendar access.',
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
    return {
      ...base,
      status: 'error',
      source: 'live',
      error: `Calendar API error: ${error.message}`,
      items: [],
      actions: [connectAction],
    };
  }
}

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
    sendHtml(res, 200, htmlPage('Google Calendar connected', 'You can close this tab and refresh your Command Tab new tab. Your upcoming events will appear in the Calendar card.'));
  } catch (err) {
    sendHtml(res, 400, htmlPage('Google authorization failed', `${err.message} You can close this tab and try again.`, '#d1242f'));
  }
}

module.exports = {
  isConfigured,
  readCalendarConnector,
  listUpcomingEvents,
  handleConnect,
  handleCallback,
  tokenFilePath,
  credentialsFilePath,
};
