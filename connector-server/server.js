#!/usr/bin/env node
'use strict';

/**
 * Command Tab local connector server.
 *
 * This is intentionally small and dependency-free. It gives the extension
 * a stable local API contract without putting credentials or service calls
 * inside browser code.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const HOST = process.env.COMMAND_TAB_HOST || '127.0.0.1';
const PORT = Number.parseInt(process.env.COMMAND_TAB_PORT || '8733', 10);
const CONTEXT_DIR = process.env.COMMAND_TAB_CONTEXT_DIR || path.join(process.cwd(), 'command-tab-context');
const EXTERNAL_BACKEND_URL = normalizeBaseUrl(process.env.COMMAND_TAB_BACKEND_URL || process.env.COMMAND_TAB_HAMILTON_URL || '');
const DEFAULT_TASKS_FILE = path.join(__dirname, '..', 'examples', 'tasks.sample.json');
const DEFAULT_WHATSAPP_FILE = path.join(__dirname, '..', 'examples', 'whatsapp.sample.json');
const DEFAULT_NOTES_FILE = path.join(__dirname, '..', 'examples', 'notes.sample.json');

function normalizeBaseUrl(value) {
  return String(value || '').replace(/\/+$/, '');
}

function contextFile(name, fallback) {
  const candidate = path.join(CONTEXT_DIR, name);
  return fs.existsSync(candidate) ? candidate : fallback;
}

function tasksFile() {
  return process.env.COMMAND_TAB_TASKS_FILE || contextFile('tasks.json', DEFAULT_TASKS_FILE);
}

function whatsappFile() {
  return process.env.COMMAND_TAB_WHATSAPP_FILE || contextFile('whatsapp.json', DEFAULT_WHATSAPP_FILE);
}

function notesFile() {
  return process.env.COMMAND_TAB_NOTES_FILE || contextFile('notes.json', DEFAULT_NOTES_FILE);
}

function fileSource(filePath, fallbackPath) {
  return path.resolve(filePath) === path.resolve(fallbackPath) ? 'template' : 'live';
}

function json(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Private-Network': 'true',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readRequestJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

async function fetchBackendJson(pathname, options = {}) {
  if (!EXTERNAL_BACKEND_URL) {
    throw new Error('No external backend configured. Set COMMAND_TAB_BACKEND_URL.');
  }
  const endpoint = `${EXTERNAL_BACKEND_URL}${pathname}`;
  const started = new Date().toISOString();
  const res = await fetch(endpoint, options);
  const text = await res.text();
  let data = {};
  if (text.trim()) {
    try {
      data = JSON.parse(text);
    } catch (error) {
      throw new Error(`${pathname} returned non-JSON (${res.status}) at ${started}: ${text.slice(0, 180)}`);
    }
  }
  if (!res.ok || data.error) {
    const detail = data.error || data.stderr || data.stdout || `${pathname} returned ${res.status}`;
    throw new Error(`${detail} at ${started}`);
  }
  return data;
}

function connectorError(id, label, kind, error, now) {
  return {
    id,
    label,
    kind,
    status: EXTERNAL_BACKEND_URL ? 'error' : 'disconnected',
    generated_at: now,
    source: EXTERNAL_BACKEND_URL ? 'live' : 'none',
    error: error.message || String(error),
    items: [],
  };
}

function normalizeTask(raw, index) {
  if (!raw || typeof raw !== 'object') {
    return {
      id: `task-${index + 1}`,
      title: String(raw || `Task ${index + 1}`),
      detail: '',
      status: 'todo',
      priority: 'normal',
    };
  }
  return {
    id: String(raw.id || `task-${index + 1}`),
    title: String(raw.title || raw.name || `Task ${index + 1}`).slice(0, 160),
    detail: String(raw.detail || raw.description || raw.project || '').slice(0, 240),
    status: String(raw.status || (raw.completed ? 'done' : 'todo')),
    priority: String(raw.priority || 'normal'),
    due: raw.due ? String(raw.due) : '',
  };
}

function readTasksConnector(now) {
  const taskFile = tasksFile();
  if (!fs.existsSync(taskFile)) {
    return {
      id: 'tasks',
      label: 'Tasks',
      kind: 'local',
      status: 'disconnected',
      generated_at: now,
      source: 'none',
      error: `No task file found. Set COMMAND_TAB_TASKS_FILE or create ${taskFile}.`,
      items: [],
    };
  }

  try {
    const raw = fs.readFileSync(taskFile, 'utf8');
    const parsed = JSON.parse(raw);
    const tasks = Array.isArray(parsed) ? parsed : parsed.tasks;
    if (!Array.isArray(tasks)) {
      throw new Error('Task file must be an array or an object with a tasks array');
    }
    const activeTasks = tasks
      .map(normalizeTask)
      .filter(task => !['done', 'completed', 'archived'].includes(task.status.toLowerCase()))
      .slice(0, 8);
    const source = fileSource(taskFile, DEFAULT_TASKS_FILE);
    return {
      id: 'tasks',
      label: 'Tasks',
      kind: 'local',
      status: source === 'template' ? 'template' : 'ok',
      generated_at: now,
      source,
      source_file: taskFile,
      error: source === 'template' ? 'Sample task context. Copy examples/context to command-tab-context for private live tasks.' : null,
      items: activeTasks.map(task => ({
        title: task.title,
        detail: [task.priority !== 'normal' ? task.priority : '', task.due ? `due ${task.due}` : '', task.detail]
          .filter(Boolean)
          .join(' · '),
      })),
    };
  } catch (error) {
    return {
      id: 'tasks',
      label: 'Tasks',
      kind: 'local',
      status: 'error',
      generated_at: now,
      source: 'live',
      source_file: taskFile,
      error: `Task file error: ${error.message}`,
      items: [],
    };
  }
}

function readJsonArrayFile(filePath, key) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  const items = Array.isArray(parsed) ? parsed : parsed[key];
  if (!Array.isArray(items)) {
    throw new Error(`File must be an array or an object with a ${key} array`);
  }
  return items;
}

function readWhatsAppConnector(now) {
  const whatsAppFile = whatsappFile();
  if (!fs.existsSync(whatsAppFile)) {
    return {
      id: 'whatsapp',
      label: 'WhatsApp',
      kind: 'bridge',
      status: 'disconnected',
      generated_at: now,
      source: 'none',
      error: `No WhatsApp context file found. Create ${path.join(CONTEXT_DIR, 'whatsapp.json')} or set COMMAND_TAB_WHATSAPP_FILE.`,
      items: [],
    };
  }
  try {
    const chats = readJsonArrayFile(whatsAppFile, 'chats').slice(0, 8);
    const source = fileSource(whatsAppFile, DEFAULT_WHATSAPP_FILE);
    return {
      id: 'whatsapp',
      label: 'WhatsApp',
      kind: 'bridge',
      status: source === 'template' ? 'template' : 'ok',
      generated_at: now,
      source,
      source_file: whatsAppFile,
      error: source === 'template'
        ? 'Sample message context only. No live WhatsApp bridge is connected.'
        : 'Local message context only. No live WhatsApp bridge is connected yet.',
      items: chats.map((chat, index) => ({
        title: String(chat.name || chat.title || `Chat ${index + 1}`).slice(0, 160),
        detail: [
          chat.status ? String(chat.status) : '',
          chat.last_sent_at ? `last sent ${chat.last_sent_at}` : '',
          chat.purpose || chat.message || '',
        ].filter(Boolean).join(' · ').slice(0, 240),
      })),
    };
  } catch (error) {
    return {
      id: 'whatsapp',
      label: 'WhatsApp',
      kind: 'bridge',
      status: 'error',
      generated_at: now,
      source: 'live',
      source_file: whatsAppFile,
      error: `WhatsApp context error: ${error.message}`,
      items: [],
    };
  }
}

function readNotesConnector(now) {
  const noteFile = notesFile();
  if (!fs.existsSync(noteFile)) {
    return {
      id: 'notes',
      label: 'Notes',
      kind: 'local',
      status: 'disconnected',
      generated_at: now,
      source: 'none',
      error: `No notes context file found. Create ${path.join(CONTEXT_DIR, 'notes.json')} or set COMMAND_TAB_NOTES_FILE.`,
      items: [],
    };
  }
  try {
    const notes = readJsonArrayFile(noteFile, 'notes').slice(0, 8);
    const source = fileSource(noteFile, DEFAULT_NOTES_FILE);
    return {
      id: 'notes',
      label: 'Notes',
      kind: 'local',
      status: source === 'template' ? 'template' : 'ok',
      generated_at: now,
      source,
      source_file: noteFile,
      error: source === 'template' ? 'Sample notes context. Copy examples/context to command-tab-context for private live notes.' : null,
      items: notes.map((note, index) => ({
        title: String(note.title || `Note ${index + 1}`).slice(0, 160),
        detail: String(note.body || note.detail || note.tags || '').slice(0, 240),
      })),
    };
  } catch (error) {
    return {
      id: 'notes',
      label: 'Notes',
      kind: 'local',
      status: 'error',
      generated_at: now,
      source: 'live',
      source_file: noteFile,
      error: `Notes context error: ${error.message}`,
      items: [],
    };
  }
}

function taskDetail(task) {
  return [
    task.pinned ? 'pinned' : '',
    task.remind_until ? `hidden until ${task.remind_until}` : '',
    task.detail || task.raw || '',
  ].filter(Boolean).join(' · ').slice(0, 240);
}

async function readExternalTasksConnector(now) {
  try {
    const data = await fetchBackendJson('/api/tasks');
    const tasks = Array.isArray(data.tasks) ? data.tasks : [];
    const active = tasks
      .filter(task => !task.checked && !task.done && !task.completed)
      .slice(0, 10);
    const focus = active.find(task => task.focus || task.is_focus || task.must_finish_today) || active.find(task => task.pinned) || active[0];
    return {
      id: 'tasks',
      label: 'Tasks',
      kind: 'backend',
      status: 'ok',
      generated_at: now,
      source: 'live',
      source_url: EXTERNAL_BACKEND_URL,
      error: null,
      summary: focus ? `Focus: ${focus.title || focus.raw || 'Task'}` : 'No active tasks',
      actions: [
        { label: 'Open board', url: `${EXTERNAL_BACKEND_URL}/task-board.html` },
      ],
      items: active.map(task => ({
        id: task.id || task.line,
        title: task.title || task.raw || 'Task',
        detail: taskDetail(task),
        checked: Boolean(task.checked),
        pinned: Boolean(task.pinned),
        line: task.line,
      })),
    };
  } catch (error) {
    return connectorError('tasks', 'Tasks', 'backend', error, now);
  }
}

async function readExternalWhatsAppConnector(now) {
  try {
    const [health, latest, plan] = await Promise.all([
      fetchBackendJson('/api/whatsapp/bridge-health').catch(error => ({ error: error.message, ok: false, ready: false })),
      fetchBackendJson('/api/whatsapp/latest').catch(error => ({ error: error.message, items: [] })),
      fetchBackendJson('/api/whatsapp/daily-plan').catch(error => ({ error: error.message, chats: [] })),
    ]);
    const latestItems = Array.isArray(latest.items) ? latest.items : Array.isArray(latest.threads) ? latest.threads : [];
    const chats = Array.isArray(plan.chats) ? plan.chats : [];
    const bridgeReady = Boolean(health.ready || health.ok);
    const failedCount = chats.filter(chat => String(chat.last_status || '').startsWith('failed')).length;
    const status = bridgeReady ? 'ok' : health.error ? 'error' : 'disconnected';
    return {
      id: 'whatsapp',
      label: 'WhatsApp',
      kind: 'bridge',
      status,
      generated_at: now,
      source: 'live',
      source_url: EXTERNAL_BACKEND_URL,
      error: bridgeReady ? null : health.error || 'WhatsApp bridge is not ready.',
      summary: `${bridgeReady ? 'Bridge live' : 'Bridge down'} · ${chats.length} planned chats${failedCount ? ` · ${failedCount} failed` : ''}`,
      health,
      actions: [
        { label: 'Refresh', command: 'whatsapp-refresh' },
        ...(bridgeReady ? [] : [{ label: 'Restart bridge', command: 'whatsapp-bridge-restart' }]),
        { label: 'Review inbox', url: `${EXTERNAL_BACKEND_URL}/whatsapp-review.html` },
        { label: 'Open planner', url: `${EXTERNAL_BACKEND_URL}/whatsapp-daily-plan.html` },
      ],
      items: latestItems.slice(0, 5).map((item, index) => ({
        id: item.chat_id || item.chatId || item.id || `whatsapp-${index + 1}`,
        title: item.name || item.chat_name || item.chat || item.title || `WhatsApp ${index + 1}`,
        detail: item.summary || item.last_message || item.message || item.detail || '',
      })),
      planned: chats.slice(0, 8).map(chat => ({
        id: chat.id,
        title: chat.name || 'WhatsApp chat',
        detail: [chat.last_status || (chat.enabled === false ? 'off' : 'ready'), chat.last_sent_at || '', chat.purpose || '']
          .filter(Boolean)
          .join(' · '),
        message: chat.message || '',
        enabled: chat.enabled !== false,
      })),
    };
  } catch (error) {
    return connectorError('whatsapp', 'WhatsApp', 'bridge', error, now);
  }
}

async function readExternalGmailConnector(now) {
  try {
    const data = await fetchBackendJson('/api/gmail/latest');
    const items = Array.isArray(data.items) ? data.items : Array.isArray(data.threads) ? data.threads : [];
    return {
      id: 'gmail',
      label: 'Gmail',
      kind: 'oauth',
      status: 'ok',
      generated_at: now,
      source: 'live',
      source_url: EXTERNAL_BACKEND_URL,
      error: null,
      summary: `${items.length} review items`,
      actions: [{ label: 'Refresh Gmail', command: 'gmail-refresh' }],
      items: items.slice(0, 8).map((item, index) => ({
        id: item.id || item.thread_id || `gmail-${index + 1}`,
        title: item.subject || item.title || item.from || `Email ${index + 1}`,
        detail: [item.from || item.sender || '', item.summary || item.snippet || item.detail || ''].filter(Boolean).join(' · '),
      })),
    };
  } catch (error) {
    return connectorError('gmail', 'Gmail', 'oauth', error, now);
  }
}

async function readExternalCalendarConnector(now) {
  try {
    const data = await fetchBackendJson('/api/calendar/upcoming?hours=6');
    const events = Array.isArray(data.events) ? data.events : Array.isArray(data.items) ? data.items : [];
    return {
      id: 'calendar',
      label: 'Calendar',
      kind: 'oauth',
      status: 'ok',
      generated_at: now,
      source: 'live',
      source_url: EXTERNAL_BACKEND_URL,
      error: null,
      summary: `${events.length} upcoming`,
      items: events.slice(0, 6).map((event, index) => ({
        id: event.id || `calendar-${index + 1}`,
        title: event.summary || event.title || 'Calendar event',
        detail: [event.start || event.when || event.time || '', event.location || ''].filter(Boolean).join(' · '),
      })),
    };
  } catch (error) {
    return connectorError('calendar', 'Calendar', 'oauth', error, now);
  }
}

async function readExternalDailySystemsConnector(now) {
  try {
    const [habits, voiceNotes, agents] = await Promise.all([
      fetchBackendJson('/api/habits/today').catch(error => ({ error: error.message, habits: [] })),
      fetchBackendJson('/api/voice-notes/today').catch(error => ({ error: error.message, notes: [] })),
      fetchBackendJson('/api/agent-runs?limit=3').catch(error => ({ error: error.message, runs: [] })),
    ]);
    const habitItems = Array.isArray(habits.habits) ? habits.habits : [];
    const voiceItems = Array.isArray(voiceNotes.notes) ? voiceNotes.notes : Array.isArray(voiceNotes.items) ? voiceNotes.items : [];
    const runs = Array.isArray(agents.runs) ? agents.runs : Array.isArray(agents.items) ? agents.items : [];
    return {
      id: 'daily-systems',
      label: 'Daily Systems',
      kind: 'backend',
      status: 'ok',
      generated_at: now,
      source: 'live',
      source_url: EXTERNAL_BACKEND_URL,
      error: [habits.error, voiceNotes.error, agents.error].filter(Boolean).join(' · ') || null,
      summary: `${habitItems.length} habits · ${voiceItems.length} voice notes · ${runs.length} agent runs`,
      items: [
        ...habitItems.slice(0, 3).map(habit => ({ title: habit.name || habit.title || 'Habit', detail: habit.checked ? 'done' : 'open' })),
        ...voiceItems.slice(0, 2).map(note => ({ title: note.title || 'Voice note', detail: note.summary || note.detail || '' })),
        ...runs.slice(0, 2).map(run => ({ title: run.task_title || run.run_id || 'Agent run', detail: run.status || '' })),
      ],
    };
  } catch (error) {
    return connectorError('daily-systems', 'Daily Systems', 'backend', error, now);
  }
}

async function summaryPayload() {
  const now = new Date().toISOString();
  if (EXTERNAL_BACKEND_URL) {
    const connectors = await Promise.all([
      readExternalTasksConnector(now),
      readExternalWhatsAppConnector(now),
      readExternalGmailConnector(now),
      readExternalCalendarConnector(now),
      readExternalDailySystemsConnector(now),
      readNotesConnector(now),
    ]);
    return {
      status: connectors.some(connector => connector.status === 'ok') ? 'ok' : 'error',
      source: 'live',
      generated_at: now,
      backend_url: EXTERNAL_BACKEND_URL,
      context_dir: CONTEXT_DIR,
      error: null,
      connectors,
    };
  }
  return {
    status: 'ok',
    source: 'live',
    generated_at: now,
    error: null,
    connectors: [
      readTasksConnector(now),
      readWhatsAppConnector(now),
      readNotesConnector(now),
      {
        id: 'gmail',
        label: 'Gmail',
        kind: 'oauth',
        status: 'disconnected',
        generated_at: now,
        source: 'none',
        error: 'Gmail is not connected. Future connector should use explicit OAuth and visible failure states.',
        items: [],
      },
      {
        id: 'local-ai',
        label: 'Local AI',
        kind: 'model',
        status: 'disconnected',
        generated_at: now,
        source: 'none',
        error: 'No local model adapter configured yet.',
        items: [],
      },
    ],
  };
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Private-Network': 'true',
    });
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  if (req.method === 'GET' && url.pathname === '/api/health') {
    json(res, 200, {
      status: 'ok',
      service: 'command-tab-connector',
      generated_at: new Date().toISOString(),
      context_dir: CONTEXT_DIR,
      backend_url: EXTERNAL_BACKEND_URL || null,
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/summary') {
    summaryPayload()
      .then(payload => json(res, 200, payload))
      .catch(error => json(res, 500, {
        status: 'error',
        source: 'live',
        generated_at: new Date().toISOString(),
        error: `Summary failed: ${error.message || error}`,
        connectors: [],
      }));
    return;
  }

  if (url.pathname.startsWith('/api/backend/')) {
    if (!EXTERNAL_BACKEND_URL) {
      json(res, 400, {
        status: 'disconnected',
        error: 'No external backend configured. Set COMMAND_TAB_BACKEND_URL.',
        generated_at: new Date().toISOString(),
      });
      return;
    }
    const targetPath = `/api/${url.pathname.slice('/api/backend/'.length)}${url.search}`;
    const started = new Date().toISOString();
    readRequestJson(req)
      .then(body => fetchBackendJson(targetPath, {
        method: req.method,
        headers: req.method === 'GET' ? undefined : { 'Content-Type': 'application/json' },
        body: req.method === 'GET' ? undefined : JSON.stringify(body),
      }))
      .then(data => json(res, 200, data))
      .catch(error => json(res, 502, {
        status: 'error',
        source: 'live',
        target: targetPath,
        generated_at: new Date().toISOString(),
        error: `${error.message || error} (started ${started})`,
      }));
    return;
  }

  json(res, 404, {
    status: 'error',
    error: `Route not found: ${req.method} ${url.pathname}`,
    generated_at: new Date().toISOString(),
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Command Tab connector server listening on http://${HOST}:${PORT}`);
  console.log(`Context: ${CONTEXT_DIR}`);
  if (EXTERNAL_BACKEND_URL) console.log(`Backend: ${EXTERNAL_BACKEND_URL}`);
  console.log(`Health:  http://${HOST}:${PORT}/api/health`);
  console.log(`Summary: http://${HOST}:${PORT}/api/summary`);
});
