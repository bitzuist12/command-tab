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
const DEFAULT_TASKS_FILE = path.join(__dirname, '..', 'examples', 'tasks.sample.json');
const TASKS_FILE = process.env.COMMAND_TAB_TASKS_FILE || DEFAULT_TASKS_FILE;

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
  if (!fs.existsSync(TASKS_FILE)) {
    return {
      id: 'tasks',
      label: 'Tasks',
      kind: 'local',
      status: 'disconnected',
      generated_at: now,
      source: 'none',
      error: `No task file found. Set COMMAND_TAB_TASKS_FILE or create ${TASKS_FILE}.`,
      items: [],
    };
  }

  try {
    const raw = fs.readFileSync(TASKS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const tasks = Array.isArray(parsed) ? parsed : parsed.tasks;
    if (!Array.isArray(tasks)) {
      throw new Error('Task file must be an array or an object with a tasks array');
    }
    const activeTasks = tasks
      .map(normalizeTask)
      .filter(task => !['done', 'completed', 'archived'].includes(task.status.toLowerCase()))
      .slice(0, 8);
    return {
      id: 'tasks',
      label: 'Tasks',
      kind: 'local',
      status: 'ok',
      generated_at: now,
      source: 'live',
      source_file: TASKS_FILE,
      error: null,
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
      source_file: TASKS_FILE,
      error: `Task file error: ${error.message}`,
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
        id: 'whatsapp',
        label: 'WhatsApp',
        kind: 'bridge',
        status: 'disconnected',
        generated_at: now,
        source: 'none',
        error: 'WhatsApp bridge is not connected. Future connector should report bridge health before send actions.',
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
  console.log(`Health:  http://${HOST}:${PORT}/api/health`);
  console.log(`Summary: http://${HOST}:${PORT}/api/summary`);
});
