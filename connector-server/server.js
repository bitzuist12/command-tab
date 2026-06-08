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
const google = require('./google');

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
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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
  if (data.restart?.error) {
    throw new Error(`Restart failed: ${data.restart.error} at ${started}`);
  }
  return data;
}

function proxyGet(res, targetPath, service) {
  fetchBackendJson(targetPath)
    .then(data => json(res, 200, data))
    .catch(error => json(res, 502, {
      status: 'error',
      source: 'live',
      service,
      target: targetPath,
      generated_at: new Date().toISOString(),
      backend_url: EXTERNAL_BACKEND_URL || null,
      error: error.message || String(error),
    }));
}

function proxyPost(req, res, targetPath, service, bodyMapper = body => body) {
  readRequestJson(req)
    .then(body => {
      if (!EXTERNAL_BACKEND_URL) throw new Error(`${service} requires an external backend.`);
      return fetchBackendJson(targetPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyMapper(body)),
      });
    })
    .then(data => json(res, 200, data))
    .catch(error => json(res, 502, {
      status: 'error',
      source: 'live',
      service,
      target: targetPath,
      generated_at: new Date().toISOString(),
      backend_url: EXTERNAL_BACKEND_URL || null,
      error: error.message || String(error),
    }));
}

function loadTasksDocument(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  const tasks = Array.isArray(parsed) ? parsed : parsed.tasks;
  if (!Array.isArray(tasks)) {
    throw new Error('Task file must be an array or an object with a tasks array');
  }
  return { parsed, tasks, arrayRoot: Array.isArray(parsed) };
}

function writeTasksDocument(filePath, doc) {
  const payload = doc.arrayRoot ? doc.tasks : { ...doc.parsed, tasks: doc.tasks };
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function addLocalTask(title, detail = '') {
  const taskFile = tasksFile();
  if (fileSource(taskFile, DEFAULT_TASKS_FILE) === 'template') {
    throw new Error('Refusing to edit sample tasks. Copy examples/context to command-tab-context first.');
  }
  if (!fs.existsSync(taskFile)) {
    throw new Error(`No task file found at ${taskFile}.`);
  }
  const doc = loadTasksDocument(taskFile);
  const task = {
    id: `task-${Date.now()}`,
    title: String(title || '').trim(),
    detail: String(detail || '').trim(),
    priority: 'normal',
    status: 'todo',
  };
  if (!task.title) throw new Error('Task title is required.');
  doc.tasks.unshift(task);
  writeTasksDocument(taskFile, doc);
  return task;
}

function findLocalTaskIndex(tasks, body) {
  if (body.id !== undefined && body.id !== null) {
    const id = String(body.id);
    const index = tasks.findIndex(task => String(task.id || '') === id);
    if (index >= 0) return index;
  }
  if (body.line !== undefined && body.line !== null) {
    const line = Number(body.line);
    if (Number.isInteger(line) && line >= 0 && line < tasks.length) return line;
  }
  throw new Error('Task id or local task index is required.');
}

function updateLocalTask(body, updater) {
  const taskFile = tasksFile();
  if (fileSource(taskFile, DEFAULT_TASKS_FILE) === 'template') {
    throw new Error('Refusing to edit sample tasks. Copy examples/context to command-tab-context first.');
  }
  if (!fs.existsSync(taskFile)) {
    throw new Error(`No task file found at ${taskFile}.`);
  }
  const doc = loadTasksDocument(taskFile);
  const index = findLocalTaskIndex(doc.tasks, body);
  const current = doc.tasks[index] && typeof doc.tasks[index] === 'object' ? doc.tasks[index] : { title: String(doc.tasks[index] || '') };
  doc.tasks[index] = updater({ ...current }, index);
  writeTasksDocument(taskFile, doc);
  return doc.tasks[index];
}

async function handleTaskAction(action, body) {
  const backendPaths = {
    check: '/api/tasks/check',
    pin: '/api/tasks/pin',
    remind: '/api/tasks/remind',
    release: '/api/tasks/release-focus',
    'release-focus': '/api/tasks/release-focus',
    'move-bottom': '/api/tasks/move-bottom',
    'move-top': '/api/tasks/move-top',
    note: '/api/tasks/note-append',
    'note-append': '/api/tasks/note-append',
    agent: '/api/tasks/agent',
    title: '/api/tasks/title',
  };
  if (EXTERNAL_BACKEND_URL) {
    const target = backendPaths[action];
    if (!target) throw new Error(`Unknown task action: ${action}`);
    return fetchBackendJson(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  if (action === 'check') {
    const task = updateLocalTask(body, current => ({
      ...current,
      status: body.checked ? 'done' : 'todo',
      completed: Boolean(body.checked),
    }));
    return { status: 'ok', task, connector: readTasksConnector(new Date().toISOString()) };
  }
  if (action === 'pin') {
    const task = updateLocalTask(body, current => ({ ...current, pinned: Boolean(body.pinned) }));
    return { status: 'ok', task, connector: readTasksConnector(new Date().toISOString()) };
  }
  if (action === 'remind') {
    const task = updateLocalTask(body, current => ({ ...current, remind_until: String(body.date || '') }));
    return { status: 'ok', task, connector: readTasksConnector(new Date().toISOString()) };
  }
  if (action === 'release') {
    const task = updateLocalTask(body, current => ({ ...current, pinned: false, focus: false, is_focus: false }));
    return { status: 'ok', task, connector: readTasksConnector(new Date().toISOString()) };
  }
  if (action === 'title') {
    const task = updateLocalTask(body, current => ({ ...current, title: String(body.title || '').trim() || current.title }));
    return { status: 'ok', task, connector: readTasksConnector(new Date().toISOString()) };
  }
  if (action === 'note') {
    const note = String(body.content || '').trim();
    if (!note) throw new Error('Note content is required.');
    const task = updateLocalTask(body, current => ({
      ...current,
      notes: Array.isArray(current.notes) ? current.notes.concat([{ content: note, source: body.source || 'Command Tab', created_at: new Date().toISOString() }]) : [{ content: note, source: body.source || 'Command Tab', created_at: new Date().toISOString() }],
    }));
    return { status: 'ok', task, connector: readTasksConnector(new Date().toISOString()) };
  }
  if (action === 'agent') {
    throw new Error('Task agent action requires an external backend.');
  }
  throw new Error(`Unknown task action: ${action}`);
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

function loadNotesDocument(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  const notes = Array.isArray(parsed) ? parsed : parsed.notes;
  if (!Array.isArray(notes)) {
    throw new Error('Notes file must be an array or an object with a notes array');
  }
  return { parsed, notes, arrayRoot: Array.isArray(parsed) };
}

function writeNotesDocument(filePath, doc) {
  const payload = doc.arrayRoot ? doc.notes : { ...doc.parsed, notes: doc.notes };
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function assertEditableNotesFile() {
  const noteFile = notesFile();
  if (fileSource(noteFile, DEFAULT_NOTES_FILE) === 'template') {
    throw new Error('Refusing to edit sample notes. Copy examples/context to command-tab-context first.');
  }
  if (!fs.existsSync(noteFile)) {
    throw new Error(`No notes file found at ${noteFile}.`);
  }
  return noteFile;
}

function saveLocalNote(body) {
  const noteFile = assertEditableNotesFile();
  const doc = loadNotesDocument(noteFile);
  const id = String(body.id || `note-${Date.now()}`);
  const next = {
    id,
    title: String(body.title || 'Untitled note').trim() || 'Untitled note',
    body: String(body.body || ''),
    tags: Array.isArray(body.tags) ? body.tags : [],
    updated_at: new Date().toISOString(),
  };
  const index = doc.notes.findIndex(note => String(note.id || '') === id);
  if (index >= 0) doc.notes[index] = { ...doc.notes[index], ...next };
  else doc.notes.unshift(next);
  writeNotesDocument(noteFile, doc);
  return next;
}

function deleteLocalNote(body) {
  const noteFile = assertEditableNotesFile();
  const doc = loadNotesDocument(noteFile);
  const id = String(body.id || '');
  if (!id) throw new Error('Note id is required.');
  doc.notes = doc.notes.filter(note => String(note.id || '') !== id);
  writeNotesDocument(noteFile, doc);
  return { deleted: true, id };
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
        id: String(note.id || `note-${index + 1}`),
        title: String(note.title || `Note ${index + 1}`).slice(0, 160),
        detail: String(note.body || note.detail || note.tags || '').slice(0, 240),
        body: String(note.body || note.detail || ''),
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

function isNudgeTask(task, focus) {
  if (!task || task.checked || task.done || task.completed) return false;
  if (focus && (task.line === focus.line || task.id === focus.id)) return false;
  const text = `${task.title || ''} ${task.detail || ''} ${task.raw || ''}`.toLowerCase();
  return [
    'follow up', 'follow-up', 'nudge', 'ping', 'message', 'whatsapp', 'email',
    'invoice', 'bank', 'transfer', 'payment', 'call', 'ask ', 'check ', 'confirm',
    'send ', 'reply', 'reach out', 'remind', 'monday', 'today', 'tomorrow',
  ].some(signal => text.includes(signal));
}

function serializeTask(task) {
  return {
    id: task.id || task.line,
    title: task.title || task.raw || 'Task',
    detail: taskDetail(task),
    checked: Boolean(task.checked),
    pinned: Boolean(task.pinned),
    note_id: task.note_id || '',
    line: task.line,
  };
}

async function readExternalTasksConnector(now) {
  try {
    const data = await fetchBackendJson('/api/tasks');
    const tasks = Array.isArray(data.tasks) ? data.tasks : [];
    const active = tasks
      .filter(task => !task.checked && !task.done && !task.completed)
      .slice(0, 10);
    const focus = active.find(task => task.focus || task.is_focus || task.must_finish_today) || active.find(task => task.pinned) || active[0];
    const nudges = active.filter(task => isNudgeTask(task, focus)).slice(0, 6);
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
      focus: focus ? serializeTask(focus) : null,
      nudges: nudges.map(serializeTask),
      actions: [
        { label: 'Add task', command: 'task-add-focus' },
        { label: 'Open board', url: `${EXTERNAL_BACKEND_URL}/task-board.html` },
      ],
      items: active.map(serializeTask),
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
        detail: item.summary_7d?.structured?.action_label || item.summary || item.last_message || item.message || item.detail || '',
        body: item.summary_7d?.summary || item.messages?.slice(-1)[0]?.body || '',
        sender: item.chat_name || item.name || '',
        timestamp: item.latest_timestamp || '',
        unread: item.unread || 0,
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
        body: item.summary || item.snippet || item.body || '',
        sender: item.from || item.sender || '',
        timestamp: item.date || item.timestamp || '',
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
    const [habits, voiceNotes, agents, vietnamese, morningBrief, dailyShot] = await Promise.all([
      fetchBackendJson('/api/habits/today').catch(error => ({ error: error.message, habits: [] })),
      fetchBackendJson('/api/voice-notes/today').catch(error => ({ error: error.message, notes: [] })),
      fetchBackendJson('/api/agent-runs?limit=3').catch(error => ({ error: error.message, runs: [] })),
      fetchBackendJson('/api/vietnamese/today').catch(error => ({ error: error.message, available: false })),
      fetchBackendJson('/api/morning-brief').catch(error => ({ error: error.message })),
      fetchBackendJson('/api/daily-shot/latest?limit=6').catch(error => ({ error: error.message, entries: [] })),
    ]);
    const habitItems = Array.isArray(habits.habits) ? habits.habits : [];
    const voiceItems = Array.isArray(voiceNotes.notes) ? voiceNotes.notes : Array.isArray(voiceNotes.items) ? voiceNotes.items : [];
    const voiceCount = Number.isFinite(Number(voiceNotes.count)) ? Number(voiceNotes.count) : voiceItems.length;
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
      summary: `${habitItems.length} habits · ${voiceCount} voice notes · ${runs.length} agent runs`,
      actions: [
        { label: 'Refresh', command: 'refresh-command-center' },
      ],
      items: [
        ...habitItems.slice(0, 6).map(habit => ({
          type: 'habit',
          id: habit.id,
          title: habit.label || habit.name || habit.title || 'Habit',
          detail: habit.detail || '',
          checked: Boolean(habit.checked),
          metrics: Array.isArray(habit.metrics) ? habit.metrics : [],
        })),
        ...(voiceNotes.available ? [{
          type: 'voice',
          id: 'voice-notes-today',
          title: `${voiceNotes.count || 0} voice notes today`,
          detail: voiceNotes.latest_text || '',
        }] : []),
        ...(vietnamese.available ? [{
          type: 'vietnamese',
          id: 'vietnamese-today',
          title: vietnamese.word || 'Vietnamese',
          detail: [vietnamese.defEn || '', vietnamese.example?.vi || '', vietnamese.study?.studied_today ? 'studied today' : 'not studied'].filter(Boolean).join(' · '),
          studied_today: Boolean(vietnamese.study?.studied_today),
        }] : []),
        ...(morningBrief.gratitude || morningBrief.study_focus ? [{
          type: 'gratitude',
          id: 'gratitude',
          title: 'Gratitude / Study focus',
          detail: [morningBrief.gratitude?.content || '', morningBrief.study_focus?.content || ''].filter(Boolean).join(' · ').slice(0, 240),
        }] : []),
        ...(Array.isArray(dailyShot.entries) ? [{
          type: 'daily-shot',
          id: 'daily-shot',
          title: 'Daily shot',
          detail: dailyShot.entries[0] ? `${dailyShot.entries[0].date || ''} · ${dailyShot.entries[0].text || ''}` : 'No recent shots',
        }] : []),
        ...runs.slice(0, 3).map(run => ({
          type: 'agent',
          id: run.run_id,
          title: run.task_title || run.run_id || 'Agent run',
          detail: [run.status || '', run.final_preview || run.stderr_preview || ''].filter(Boolean).join(' · ').slice(0, 240),
        })),
      ],
    };
  } catch (error) {
    return connectorError('daily-systems', 'Daily Systems', 'backend', error, now);
  }
}

async function readExternalAgentInboxConnector(now) {
  try {
    const data = await fetchBackendJson('/api/agent-inbox?limit=6');
    const requests = Array.isArray(data.requests) ? data.requests : [];
    return {
      id: 'agent-inbox',
      label: 'Agent Inbox',
      kind: 'backend',
      status: 'ok',
      generated_at: now,
      source: 'live',
      source_url: EXTERNAL_BACKEND_URL,
      error: null,
      summary: `${requests.length} recent requests`,
      items: requests.slice(0, 6).map(req => ({
        id: req.request_id || req.run_id,
        title: req.task_title || req.request_id || 'Agent request',
        detail: [req.status || '', req.needs_direction ? 'needs direction' : '', req.ata_direction || req.task_detail || ''].filter(Boolean).join(' · ').slice(0, 240),
        body: [req.task_detail || '', req.task_note_preview || '', req.ata_direction || ''].filter(Boolean).join('\n\n').slice(0, 1200),
        status: req.status || '',
        path: req.run_dir || '',
      })),
    };
  } catch (error) {
    return connectorError('agent-inbox', 'Agent Inbox', 'backend', error, now);
  }
}

async function readExternalMemoryConnector(now) {
  return {
    id: 'memory',
    label: 'Memory Search',
    kind: 'backend',
    status: EXTERNAL_BACKEND_URL ? 'ok' : 'disconnected',
    generated_at: now,
    source: EXTERNAL_BACKEND_URL ? 'live' : 'none',
    error: EXTERNAL_BACKEND_URL ? null : 'No external backend configured.',
    summary: 'Search local project memory',
    items: [],
  };
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
      readExternalAgentInboxConnector(now),
      readExternalMemoryConnector(now),
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
  const [calendarConnector, gmailConnector] = await Promise.all([
    google.readCalendarConnector(now),
    google.readGmailConnector(now),
  ]);
  return {
    status: 'ok',
    source: 'live',
    generated_at: now,
    error: null,
    connectors: [
      readTasksConnector(now),
      readWhatsAppConnector(now),
      gmailConnector,
      calendarConnector,
      readNotesConnector(now),
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

  if (req.method === 'GET' && url.pathname === '/api/google/connect') {
    google.handleConnect(req, res, url);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/google/callback') {
    google.handleCallback(req, res, url).catch(error => json(res, 500, {
      status: 'error',
      error: `Google callback failed: ${error.message || error}`,
      generated_at: new Date().toISOString(),
    }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/calendar/upcoming' && !EXTERNAL_BACKEND_URL) {
    const parsedHours = Number.parseInt(url.searchParams.get('hours') || '12', 10);
    const hours = Number.isFinite(parsedHours) && parsedHours > 0 ? parsedHours : 12;
    google.listUpcomingEvents({ hours })
      .then(events => json(res, 200, { status: 'ok', source: 'live', generated_at: new Date().toISOString(), events }))
      .catch(error => json(res, 502, {
        status: 'error',
        source: 'live',
        service: 'calendar',
        generated_at: new Date().toISOString(),
        error: error.message || String(error),
        events: [],
      }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/gmail/latest' && !EXTERNAL_BACKEND_URL) {
    google.listRecentMail({ query: url.searchParams.get('q') || undefined })
      .then(items => json(res, 200, { status: 'ok', source: 'live', generated_at: new Date().toISOString(), items }))
      .catch(error => json(res, 502, {
        status: 'error',
        source: 'live',
        service: 'gmail',
        generated_at: new Date().toISOString(),
        error: error.message || String(error),
        items: [],
      }));
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

  if (req.method === 'GET' && url.pathname === '/api/tasks') {
    if (EXTERNAL_BACKEND_URL) {
      proxyGet(res, `/api/tasks${url.search}`, 'tasks');
      return;
    }
    try {
      const connector = readTasksConnector(new Date().toISOString());
      json(res, 200, { tasks: connector.items || [], connector });
    } catch (error) {
      json(res, 400, { status: 'error', source: 'local', service: 'tasks', generated_at: new Date().toISOString(), error: error.message || String(error) });
    }
    return;
  }

  const backendGetRoutes = new Map([
    ['/api/task-note', 'task-note'],
    ['/api/task-agent', 'task-agent'],
    ['/api/whatsapp/latest', 'whatsapp'],
    ['/api/whatsapp/latest-html', 'whatsapp'],
    ['/api/whatsapp/daily-plan', 'whatsapp'],
    ['/api/whatsapp/bridge-health', 'whatsapp'],
    ['/api/gmail/latest', 'gmail'],
    ['/api/automation-output/latest', 'automation-output'],
    ['/api/morning-brief', 'morning-brief'],
    ['/api/daily-shot/latest', 'daily-shot'],
    ['/api/habits/today', 'habits'],
    ['/api/vietnamese/today', 'vietnamese'],
    ['/api/voice-notes/today', 'voice-notes'],
    ['/api/calendar/upcoming', 'calendar'],
    ['/api/agent-runs', 'agent-runs'],
    ['/api/agent-inbox', 'agent-inbox'],
  ]);

  if (req.method === 'GET' && backendGetRoutes.has(url.pathname)) {
    if (!EXTERNAL_BACKEND_URL) {
      json(res, 400, {
        status: 'disconnected',
        source: 'none',
        service: backendGetRoutes.get(url.pathname),
        generated_at: new Date().toISOString(),
        error: `${url.pathname} requires an external backend.`,
      });
      return;
    }
    proxyGet(res, `${url.pathname}${url.search}`, backendGetRoutes.get(url.pathname));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/tasks/add') {
    readRequestJson(req)
      .then(body => {
        if (EXTERNAL_BACKEND_URL) {
          return fetchBackendJson('/api/tasks/add', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              section: body.section || 'Active',
              title: body.title,
              detail: body.detail || '',
            }),
          });
        }
        const task = addLocalTask(body.title, body.detail || '');
        return {
          status: 'ok',
          source: 'live',
          task,
          connector: readTasksConnector(new Date().toISOString()),
        };
      })
      .then(data => json(res, 200, data))
      .catch(error => json(res, 400, {
        status: 'error',
        source: EXTERNAL_BACKEND_URL ? 'live' : 'local',
        generated_at: new Date().toISOString(),
        error: error.message || String(error),
      }));
    return;
  }

  if (req.method === 'POST' && url.pathname.startsWith('/api/tasks/')) {
    const action = url.pathname.slice('/api/tasks/'.length);
    readRequestJson(req)
      .then(body => handleTaskAction(action, body))
      .then(data => json(res, 200, data))
      .catch(error => json(res, 400, {
        status: 'error',
        source: EXTERNAL_BACKEND_URL ? 'live' : 'local',
        action,
        generated_at: new Date().toISOString(),
        error: error.message || String(error),
      }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/task-note') {
    proxyPost(req, res, '/api/task-note', 'task-note', body => ({
      id: body.id || body.note_id || '',
      content: body.content || '',
    }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/whatsapp/refresh') {
    proxyPost(req, res, '/api/whatsapp/refresh', 'whatsapp-refresh');
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/gmail/refresh') {
    proxyPost(req, res, '/api/gmail/refresh', 'gmail-refresh');
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/whatsapp/daily-plan') {
    proxyPost(req, res, '/api/whatsapp/daily-plan', 'whatsapp-daily-plan');
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/whatsapp/bridge-restart') {
    readRequestJson(req)
      .then(() => fetchBackendJson('/api/whatsapp/bridge-restart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }))
      .then(data => json(res, 200, data))
      .catch(error => json(res, 502, {
        status: 'error',
        source: 'live',
        service: 'whatsapp',
        action: 'bridge-restart',
        generated_at: new Date().toISOString(),
        backend_url: EXTERNAL_BACKEND_URL || null,
        error: error.message || String(error),
      }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/whatsapp/daily-plan/send') {
    readRequestJson(req)
      .then(async body => {
        if (!EXTERNAL_BACKEND_URL) {
          throw new Error('WhatsApp daily-plan sending requires an external backend.');
        }
        const health = await fetchBackendJson('/api/whatsapp/bridge-health').catch(error => ({
          ok: false,
          ready: false,
          error: error.message || String(error),
        }));
        if (!health.ready && !health.ok) {
          throw new Error(`WhatsApp bridge preflight failed: ${health.error || 'bridge is not ready'}`);
        }
        return fetchBackendJson('/api/whatsapp/daily-plan/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: body.id,
            text: body.text,
          }),
        });
      })
      .then(data => json(res, 200, data))
      .catch(error => json(res, 400, {
        status: 'error',
        source: 'live',
        service: 'whatsapp',
        action: 'daily-plan-send',
        generated_at: new Date().toISOString(),
        error: error.message || String(error),
      }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/whatsapp/send') {
    readRequestJson(req)
      .then(async body => {
        if (!EXTERNAL_BACKEND_URL) {
          throw new Error('WhatsApp sending requires an external backend.');
        }
        const chat = String(body.chat || body.chat_id || '').trim();
        const text = String(body.text || '').trim();
        if (!chat) throw new Error('WhatsApp chat id/name is required.');
        if (!text) throw new Error('WhatsApp message text is required.');
        const health = await fetchBackendJson('/api/whatsapp/bridge-health').catch(error => ({
          ok: false,
          ready: false,
          error: error.message || String(error),
        }));
        if (!health.ready && !health.ok) {
          throw new Error(`WhatsApp bridge preflight failed: ${health.error || 'bridge is not ready'}`);
        }
        return fetchBackendJson('/api/whatsapp/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat, text }),
        });
      })
      .then(data => json(res, 200, data))
      .catch(error => json(res, 400, {
        status: 'error',
        source: 'live',
        service: 'whatsapp',
        action: 'send',
        generated_at: new Date().toISOString(),
        error: error.message || String(error),
      }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/habits/check') {
    readRequestJson(req)
      .then(body => {
        if (!EXTERNAL_BACKEND_URL) throw new Error('Habit checking requires an external backend.');
        return fetchBackendJson('/api/habits/check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            habit_id: body.habit_id,
            checked: Boolean(body.checked),
            metrics: body.metrics || null,
          }),
        });
      })
      .then(data => json(res, 200, data))
      .catch(error => json(res, 400, {
        status: 'error',
        source: 'live',
        service: 'habits',
        action: 'check',
        generated_at: new Date().toISOString(),
        error: error.message || String(error),
      }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/gratitude') {
    readRequestJson(req)
      .then(body => {
        if (!EXTERNAL_BACKEND_URL) throw new Error('Gratitude save requires an external backend.');
        return fetchBackendJson('/api/gratitude', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: body.text || '' }),
        });
      })
      .then(data => json(res, 200, data))
      .catch(error => json(res, 400, { status: 'error', source: 'live', service: 'gratitude', generated_at: new Date().toISOString(), error: error.message || String(error) }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/vietnamese/study') {
    readRequestJson(req)
      .then(body => {
        if (!EXTERNAL_BACKEND_URL) throw new Error('Vietnamese study save requires an external backend.');
        return fetchBackendJson('/api/vietnamese/study', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ note: body.note || '' }),
        });
      })
      .then(data => json(res, 200, data))
      .catch(error => json(res, 400, { status: 'error', source: 'live', service: 'vietnamese', generated_at: new Date().toISOString(), error: error.message || String(error) }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/daily-shot/log') {
    readRequestJson(req)
      .then(body => {
        if (!EXTERNAL_BACKEND_URL) throw new Error('Daily shot save requires an external backend.');
        return fetchBackendJson('/api/daily-shot/log', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: body.text || '' }),
        });
      })
      .then(data => json(res, 200, data))
      .catch(error => json(res, 400, { status: 'error', source: 'live', service: 'daily-shot', generated_at: new Date().toISOString(), error: error.message || String(error) }));
    return;
  }

  if (req.method === 'POST' && (url.pathname === '/api/voice-notes/open' || url.pathname === '/api/voice-notes/open-folder')) {
    const target = url.pathname;
    readRequestJson(req)
      .then(() => {
        if (!EXTERNAL_BACKEND_URL) throw new Error('Voice note open requires an external backend.');
        return fetchBackendJson(target, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      })
      .then(data => json(res, 200, data))
      .catch(error => json(res, 400, { status: 'error', source: 'live', service: 'voice-notes', generated_at: new Date().toISOString(), error: error.message || String(error) }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/memory/search') {
    if (!EXTERNAL_BACKEND_URL) {
      json(res, 400, { status: 'disconnected', source: 'none', generated_at: new Date().toISOString(), error: 'Memory search requires an external backend.' });
      return;
    }
    fetchBackendJson(`/api/memory/search${url.search || '?q='}`)
      .then(data => json(res, 200, data))
      .catch(error => json(res, 400, { status: 'error', source: 'live', service: 'memory', generated_at: new Date().toISOString(), error: error.message || String(error), results: [] }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/notes/save') {
    readRequestJson(req)
      .then(body => saveLocalNote(body))
      .then(note => json(res, 200, { status: 'ok', source: 'live', note, connector: readNotesConnector(new Date().toISOString()) }))
      .catch(error => json(res, 400, { status: 'error', source: 'local', service: 'notes', generated_at: new Date().toISOString(), error: error.message || String(error) }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/notes/delete') {
    readRequestJson(req)
      .then(body => deleteLocalNote(body))
      .then(result => json(res, 200, { status: 'ok', source: 'live', ...result, connector: readNotesConnector(new Date().toISOString()) }))
      .catch(error => json(res, 400, { status: 'error', source: 'local', service: 'notes', generated_at: new Date().toISOString(), error: error.message || String(error) }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/memory/open') {
    readRequestJson(req)
      .then(body => {
        if (!EXTERNAL_BACKEND_URL) throw new Error('Memory open requires an external backend.');
        return fetchBackendJson('/api/memory/open', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: body.path || '' }),
        });
      })
      .then(data => json(res, 200, data))
      .catch(error => json(res, 400, { status: 'error', source: 'live', service: 'memory', generated_at: new Date().toISOString(), error: error.message || String(error) }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/codex/open') {
    readRequestJson(req)
      .then(body => {
        if (!EXTERNAL_BACKEND_URL) throw new Error('Codex open requires an external backend.');
        return fetchBackendJson('/api/codex/open', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: body.path || '' }),
        });
      })
      .then(data => json(res, 200, data))
      .catch(error => json(res, 400, { status: 'error', source: 'live', service: 'codex', generated_at: new Date().toISOString(), error: error.message || String(error) }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/memory/brief') {
    proxyPost(req, res, '/api/memory/brief', 'memory-brief', body => ({
      query: body.query || '',
      results: Array.isArray(body.results) ? body.results : undefined,
      project: body.project || '',
      workspace: body.workspace || '',
      kind: body.kind || '',
      include_code: Boolean(body.include_code),
    }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/memory/reindex') {
    proxyPost(req, res, '/api/memory/reindex', 'memory-reindex');
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
