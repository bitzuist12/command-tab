'use strict';

/**
 * File-driven custom cards for Command Tab.
 *
 * "Drop a file, get a card." The connector server scans CONTEXT_DIR/cards/ and
 * turns every .json or .md file into a card on the new tab. No code changes are
 * needed to add, remove, or reorder cards — just add/edit/delete files. Agents
 * can be pointed at this folder: "write a file to command-tab-context/cards/".
 *
 * Card types (the file declares which):
 *   - list      read-only rows (optionally links via item.url)
 *   - checklist checkable rows; state is written back to the file
 *   - note      freeform text; written back to the file
 *   - input     a prompt + box that appends timestamped entries to a log file
 *
 * Markdown files map to `note` by default, or `checklist` when they contain
 * `- [ ]` / `- [x]` lines. JSON files use an explicit `type` (default `list`).
 *
 * Dependency-free: fs + path only. Every parse failure surfaces as an `error`
 * card; nothing is faked.
 */

const fs = require('fs');
const path = require('path');

const CONTEXT_DIR = process.env.COMMAND_TAB_CONTEXT_DIR || path.join(process.cwd(), 'command-tab-context');
const VALID_TYPES = new Set(['list', 'checklist', 'note', 'input', 'links']);

function cardsDir() {
  return process.env.COMMAND_TAB_CARDS_DIR || path.join(CONTEXT_DIR, 'cards');
}

function logsDir() {
  return path.join(cardsDir(), 'logs');
}

function cardIdFromName(name) {
  return `card-${name.replace(/\.(json|md|markdown)$/i, '')}`;
}

/** List card files in deterministic (filename) order. */
function listCardFiles() {
  const dir = cardsDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(name => /\.(json|md|markdown)$/i.test(name))
    .filter(name => !name.startsWith('.') && !name.startsWith('_'))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

/** Resolve a card id back to its file, validating it stays inside cards/. */
function resolveCardFile(id) {
  const file = listCardFiles().find(name => cardIdFromName(name) === id);
  if (!file) throw new Error(`No card found for id "${id}".`);
  const full = path.join(cardsDir(), file);
  const real = fs.realpathSync(path.dirname(full));
  if (!real.startsWith(fs.realpathSync(cardsDir()))) {
    throw new Error('Refusing to write outside the cards folder.');
  }
  return full;
}

function parseFrontmatter(raw) {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  if (!match) return { meta: {}, body: raw };
  const meta = {};
  for (const line of match[1].split('\n')) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
    if (m) meta[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return { meta, body: match[2] };
}

const CHECKBOX_RE = /^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/;

function parseMarkdownCard(name, raw) {
  const { meta, body } = parseFrontmatter(raw);
  const lines = body.split('\n');
  const checkboxLines = lines.filter(l => CHECKBOX_RE.test(l));
  const declaredType = String(meta.type || '').toLowerCase();
  const type = VALID_TYPES.has(declaredType) ? declaredType : (checkboxLines.length ? 'checklist' : 'note');
  const card = {
    title: meta.title || name.replace(/\.(md|markdown)$/i, '').replace(/^\d+[-_\s]*/, ''),
    type,
    accent: meta.accent || '',
    subtitle: meta.subtitle || meta.prompt || '',
    format: 'md',
  };
  if (type === 'checklist') {
    card.items = checkboxLines.map(l => {
      const m = CHECKBOX_RE.exec(l);
      return { label: m[2].trim(), checked: m[1].toLowerCase() === 'x' };
    });
  } else if (type === 'input') {
    card.placeholder = meta.placeholder || 'Add an entry...';
    card.log = meta.log || `${cardIdFromName(name)}.jsonl`;
  } else {
    card.body = body.replace(/^\n+|\n+$/g, '');
  }
  return card;
}

function parseJsonCard(name, raw) {
  const parsed = JSON.parse(raw);
  const declaredType = String(parsed.type || '').toLowerCase();
  const type = VALID_TYPES.has(declaredType) ? (declaredType === 'links' ? 'list' : declaredType) : 'list';
  const card = {
    title: parsed.title || parsed.label || name.replace(/\.json$/i, '').replace(/^\d+[-_\s]*/, ''),
    type,
    accent: parsed.accent || '',
    subtitle: parsed.subtitle || parsed.prompt || '',
    format: 'json',
  };
  if (type === 'note') {
    card.body = String(parsed.body || parsed.text || '');
  } else if (type === 'input') {
    card.placeholder = parsed.placeholder || 'Add an entry...';
    card.log = parsed.log || `${cardIdFromName(name)}.jsonl`;
  } else {
    // list / checklist
    card.items = (Array.isArray(parsed.items) ? parsed.items : []).map(item => {
      if (item && typeof item === 'object') {
        return {
          label: String(item.label || item.title || ''),
          detail: String(item.detail || item.description || ''),
          url: item.url ? String(item.url) : '',
          checked: Boolean(item.checked),
        };
      }
      return { label: String(item || ''), detail: '', url: '', checked: false };
    });
  }
  return card;
}

/** Read recent entries (last N) from an input card's JSONL log. */
function readLogEntries(logName, max = 5) {
  const file = path.isAbsolute(logName) ? logName : path.join(cardsDir(), logName);
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split('\n').map(l => l.trim()).filter(Boolean);
  return lines.slice(-max).reverse().map(line => {
    try {
      const obj = JSON.parse(line);
      return { text: String(obj.text || ''), at: String(obj.at || '') };
    } catch (_error) {
      return { text: line, at: '' };
    }
  });
}

/** Build all card connectors for /api/summary. Returns [] if no cards/ dir. */
function readCardConnectors(now) {
  return listCardFiles().map(name => {
    const id = cardIdFromName(name);
    const file = path.join(cardsDir(), name);
    const base = { id, kind: 'card', generated_at: now, source: 'live', file: name };
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = /\.(md|markdown)$/i.test(name) ? parseMarkdownCard(name, raw) : parseJsonCard(name, raw);
      const card = { ...base, ...parsed, label: parsed.title, status: 'ok', error: null };
      if (card.type === 'input') card.entries = readLogEntries(card.log);
      return card;
    } catch (error) {
      return {
        ...base,
        label: name,
        type: 'note',
        status: 'error',
        error: `Card file error (${name}): ${error.message}`,
        items: [],
      };
    }
  });
}

// ---------------------------------------------------------------------------
// Write-back
// ---------------------------------------------------------------------------

function toggleChecklistItem(id, index, checked) {
  const file = resolveCardFile(id);
  const raw = fs.readFileSync(file, 'utf8');
  if (/\.(md|markdown)$/i.test(file)) {
    let seen = -1;
    const out = raw.split('\n').map(line => {
      if (CHECKBOX_RE.test(line)) {
        seen += 1;
        if (seen === index) return line.replace(/\[( |x|X)\]/, `[${checked ? 'x' : ' '}]`);
      }
      return line;
    }).join('\n');
    fs.writeFileSync(file, out);
  } else {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.items) || !parsed.items[index]) throw new Error('Checklist item not found.');
    if (typeof parsed.items[index] !== 'object') parsed.items[index] = { label: String(parsed.items[index]) };
    parsed.items[index].checked = Boolean(checked);
    fs.writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`);
  }
  return { ok: true };
}

function saveNote(id, body) {
  const file = resolveCardFile(id);
  const raw = fs.readFileSync(file, 'utf8');
  if (/\.(md|markdown)$/i.test(file)) {
    const fm = /^(---\n[\s\S]*?\n---\n?)/.exec(raw);
    const prefix = fm ? fm[1] : '';
    fs.writeFileSync(file, `${prefix}${prefix && !prefix.endsWith('\n') ? '\n' : ''}${body}\n`);
  } else {
    const parsed = JSON.parse(raw);
    parsed.body = String(body);
    fs.writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`);
  }
  return { ok: true };
}

function appendInput(id, text) {
  const file = resolveCardFile(id);
  const raw = fs.readFileSync(file, 'utf8');
  const parsed = /\.(md|markdown)$/i.test(file) ? parseMarkdownCard(path.basename(file), raw) : parseJsonCard(path.basename(file), raw);
  if (parsed.type !== 'input') throw new Error('Card is not an input card.');
  const logName = parsed.log || `${id}.jsonl`;
  const logFile = path.isAbsolute(logName) ? logName : path.join(cardsDir(), logName);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const entry = { text: String(text || '').trim(), at: new Date().toISOString() };
  if (!entry.text) throw new Error('Entry text is required.');
  fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
  return { ok: true, entry };
}

module.exports = {
  cardsDir,
  logsDir,
  readCardConnectors,
  toggleChecklistItem,
  saveNote,
  appendInput,
};
