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

const HOST = process.env.COMMAND_TAB_HOST || '127.0.0.1';
const PORT = Number.parseInt(process.env.COMMAND_TAB_PORT || '8733', 10);

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

function summaryPayload() {
  const now = new Date().toISOString();
  return {
    status: 'ok',
    source: 'template',
    generated_at: now,
    error: null,
    connectors: [
      {
        id: 'tasks',
        label: 'Tasks',
        kind: 'local',
        status: 'template',
        generated_at: now,
        source: 'template',
        error: 'Template connector only. No real task source is connected yet.',
        items: [
          { title: 'Design connector contract', detail: 'Replace this with local JSON, Markdown, Todoist, or Linear.' },
          { title: 'Keep tab cleanup useful without setup', detail: 'The extension should work even with no connector server.' },
        ],
      },
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
  console.log('Health:  http://127.0.0.1:8733/api/health');
  console.log('Summary: http://127.0.0.1:8733/api/summary');
});
