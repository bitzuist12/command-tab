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
const DEFAULT_TASKS_FILE = path.join(__dirname, '..', 'examples', 'tasks.sample.json');
const DEFAULT_WHATSAPP_FILE = path.join(__dirname, '..', 'examples', 'whatsapp.sample.json');
const DEFAULT_NOTES_FILE = path.join(__dirname, '..', 'examples', 'notes.sample.json');

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

function summaryPayload() {
  const now = new Date().toISOString();
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
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/summary') {
    json(res, 200, summaryPayload());
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
  console.log(`Health:  http://${HOST}:${PORT}/api/health`);
  console.log(`Summary: http://${HOST}:${PORT}/api/summary`);
});
