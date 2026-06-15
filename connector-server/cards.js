'use strict';

/**
 * File-driven custom cards for Command Tab.
 *
 * "Drop a file, get a card." The server scans one or more card folders and
 * turns every .json or .md file into a card on the new tab. No code changes are
 * needed to add, remove, or reorder cards. Agents can be pointed at a folder:
 * "write a file to command-tab-context/cards/".
 *
 * Card sources (in order):
 *   1. The primary folder (COMMAND_TAB_CARDS_DIR or CONTEXT_DIR/cards) -- WRITABLE.
 *   2. COMMAND_TAB_CARDS_DIRS (comma-separated paths) -- READ-ONLY.
 *   3. settings.json "card_sources": [ "~/path", { "path": "...", "readonly": false, "label": "..." } ]
 *      -- READ-ONLY by default; opt into writes with "readonly": false.
 *
 * SAFETY: extra folders are read-only by default, so write-back (toggling a
 * checklist, saving a note, appending an input entry) can never modify files in
 * another system unless you explicitly opt in. Reading is always non-destructive.
 *
 * Card types: list, checklist, note, input. Markdown files map to `note`, or
 * `checklist` when they contain `- [ ]` / `- [x]` lines. JSON uses `type`
 * (default `list`). Dependency-free: fs + path + os only. Parse failures
 * surface as `error` cards; nothing is faked.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const VALID_TYPES = new Set(['list', 'checklist', 'note', 'input', 'links']);

function contextDir() {
  return process.env.COMMAND_TAB_CONTEXT_DIR || path.join(process.cwd(), 'command-tab-context');
}

function expandHome(p) {
  const s = String(p || '').trim();
  if (s === '~') return os.homedir();
  if (s.startsWith('~/')) return path.join(os.homedir(), s.slice(2));
  return s;
}

/** Primary, writable cards folder. */
function cardsDir() {
  return process.env.COMMAND_TAB_CARDS_DIR || path.join(contextDir(), 'cards');
}

function readSettings() {
  const file = path.join(contextDir(), 'settings.json');
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) || {};
  } catch (_error) {
    return {};
  }
}

/**
 * Resolve the ordered list of card sources: { dir, readonly, label }.
 * The primary source is always writable; extra sources default to read-only.
 */
function cardSources() {
  const sources = [{ dir: cardsDir(), readonly: false, label: 'cards' }];
  const seen = new Set([path.resolve(sources[0].dir)]);

  const addExtra = (raw) => {
    if (!raw) return;
    let dir; let readonly = true; let label = '';
    if (typeof raw === 'string') {
      dir = expandHome(raw);
    } else if (typeof raw === 'object' && raw.path) {
      dir = expandHome(raw.path);
      readonly = raw.readonly !== false; // read-only unless explicitly false
      label = String(raw.label || '');
    } else {
      return;
    }
    const resolved = path.resolve(dir);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    sources.push({ dir, readonly, label: label || path.basename(resolved) });
  };

  String(process.env.COMMAND_TAB_CARDS_DIRS || '')
    .split(',').map(s => s.trim()).filter(Boolean).forEach(addExtra);

  const fromSettings = readSettings().card_sources;
  if (Array.isArray(fromSettings)) fromSettings.forEach(addExtra);

  return sources;
}

function cardIdFromName(name, sourceIndex) {
  const base = name.replace(/\.(json|md|markdown)$/i, '');
  return sourceIndex > 0 ? `card-s${sourceIndex}-${base}` : `card-${base}`;
}

function listSourceFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(name => /\.(json|md|markdown)$/i.test(name))
    .filter(name => !name.startsWith('.') && !name.startsWith('_'))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

/** All card files across all sources: { id, file, name, readonly, sourceLabel, dir }. */
function listAllCardFiles() {
  const entries = [];
  cardSources().forEach((source, sourceIndex) => {
    listSourceFiles(source.dir).forEach(name => {
      entries.push({
        id: cardIdFromName(name, sourceIndex),
        file: path.join(source.dir, name),
        name,
        readonly: source.readonly,
        sourceLabel: source.label,
        dir: source.dir,
      });
    });
  });
  return entries;
}

/** Find a card entry by id, validating the file stays inside its source dir. */
function findCardEntry(id) {
  const entry = listAllCardFiles().find(e => e.id === id);
  if (!entry) throw new Error(`No card found for id "${id}".`);
  const realFileDir = fs.realpathSync(path.dirname(entry.file));
  if (!realFileDir.startsWith(fs.realpathSync(entry.dir))) {
    throw new Error('Refusing to write outside the card source folder.');
  }
  return entry;
}

function assertWritable(entry) {
  if (entry.readonly) {
    throw new Error(`Card "${entry.name}" is read-only (source: ${entry.sourceLabel}). Set "readonly": false on that source to allow edits.`);
  }
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
    card.log = meta.log || `${cardIdFromName(name, 0)}.jsonl`;
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
    card.log = parsed.log || `${cardIdFromName(name, 0)}.jsonl`;
  } else {
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
function readLogEntries(logFile, max = 5) {
  if (!fs.existsSync(logFile)) return [];
  const lines = fs.readFileSync(logFile, 'utf8').split('\n').map(l => l.trim()).filter(Boolean);
  return lines.slice(-max).reverse().map(line => {
    try {
      const obj = JSON.parse(line);
      return { text: String(obj.text || ''), at: String(obj.at || '') };
    } catch (_error) {
      return { text: line, at: '' };
    }
  });
}

function logFileFor(entry, logName) {
  return path.isAbsolute(logName) ? logName : path.join(path.dirname(entry.file), logName);
}

/** Build all card connectors for /api/summary. Returns [] if no sources exist. */
function readCardConnectors(now) {
  return listAllCardFiles().map(entry => {
    const base = {
      id: entry.id, kind: 'card', generated_at: now, source: 'live',
      file: entry.name, readonly: entry.readonly, source_label: entry.sourceLabel,
    };
    try {
      const raw = fs.readFileSync(entry.file, 'utf8');
      const parsed = /\.(md|markdown)$/i.test(entry.file) ? parseMarkdownCard(entry.name, raw) : parseJsonCard(entry.name, raw);
      const card = { ...base, ...parsed, label: parsed.title, status: 'ok', error: null };
      if (card.type === 'input') card.entries = readLogEntries(logFileFor(entry, card.log));
      return card;
    } catch (error) {
      return { ...base, label: entry.name, type: 'note', status: 'error', error: `Card file error (${entry.name}): ${error.message}`, items: [] };
    }
  });
}

// ---------------------------------------------------------------------------
// Write-back (refuses read-only sources)
// ---------------------------------------------------------------------------

function toggleChecklistItem(id, index, checked) {
  const entry = findCardEntry(id);
  assertWritable(entry);
  const raw = fs.readFileSync(entry.file, 'utf8');
  if (/\.(md|markdown)$/i.test(entry.file)) {
    let seen = -1;
    const out = raw.split('\n').map(line => {
      if (CHECKBOX_RE.test(line)) {
        seen += 1;
        if (seen === index) return line.replace(/\[( |x|X)\]/, `[${checked ? 'x' : ' '}]`);
      }
      return line;
    }).join('\n');
    fs.writeFileSync(entry.file, out);
  } else {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.items) || !parsed.items[index]) throw new Error('Checklist item not found.');
    if (typeof parsed.items[index] !== 'object') parsed.items[index] = { label: String(parsed.items[index]) };
    parsed.items[index].checked = Boolean(checked);
    fs.writeFileSync(entry.file, `${JSON.stringify(parsed, null, 2)}\n`);
  }
  return { ok: true };
}

function saveNote(id, body) {
  const entry = findCardEntry(id);
  assertWritable(entry);
  const raw = fs.readFileSync(entry.file, 'utf8');
  if (/\.(md|markdown)$/i.test(entry.file)) {
    const fm = /^(---\n[\s\S]*?\n---\n?)/.exec(raw);
    const prefix = fm ? fm[1] : '';
    fs.writeFileSync(entry.file, `${prefix}${prefix && !prefix.endsWith('\n') ? '\n' : ''}${body}\n`);
  } else {
    const parsed = JSON.parse(raw);
    parsed.body = String(body);
    fs.writeFileSync(entry.file, `${JSON.stringify(parsed, null, 2)}\n`);
  }
  return { ok: true };
}

function appendInput(id, text) {
  const entry = findCardEntry(id);
  assertWritable(entry);
  const raw = fs.readFileSync(entry.file, 'utf8');
  const parsed = /\.(md|markdown)$/i.test(entry.file) ? parseMarkdownCard(entry.name, raw) : parseJsonCard(entry.name, raw);
  if (parsed.type !== 'input') throw new Error('Card is not an input card.');
  const logFile = logFileFor(entry, parsed.log || `${id}.jsonl`);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const value = { text: String(text || '').trim(), at: new Date().toISOString() };
  if (!value.text) throw new Error('Entry text is required.');
  fs.appendFileSync(logFile, `${JSON.stringify(value)}\n`);
  return { ok: true, entry: value };
}

module.exports = {
  cardsDir,
  cardSources,
  readCardConnectors,
  toggleChecklistItem,
  saveNote,
  appendInput,
};
