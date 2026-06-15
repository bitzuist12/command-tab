# Connectors

Command Tab uses an optional connector server instead of putting Gmail, WhatsApp, Calendar, filesystem, or model credentials in browser extension code.

The default private workspace is:

```text
./command-tab-context/
```

It is gitignored. Use `examples/context/` as the template.

## Local Development

```bash
npm run connector
```

Then open:

```text
http://127.0.0.1:8733/api/health
http://127.0.0.1:8733/api/summary
```

The current server includes local context connectors for tasks, WhatsApp/message drafts, and notes. By default it reads `./command-tab-context/` when present, otherwise sample files in `examples/`.

To connect an existing local command-center backend:

```bash
COMMAND_TAB_BACKEND_URL=http://127.0.0.1:8765 npm run connector
```

When a backend URL is configured, `/api/summary` attempts compatible backend calls for tasks, WhatsApp bridge/daily plan/latest review, Gmail latest review, calendar upcoming, habits, voice notes, memory, and agent runs. Each failed call returns an explicit `error` connector instead of sample content.

## Custom Cards (drop a file, get a card)

The fastest way to put your own stuff on the new tab. The connector server
scans `command-tab-context/cards/` and turns **every `.json` or `.md` file into
a card**. Add, remove, or reorder cards by changing files — no code required.
Filenames sort the cards (use numeric prefixes like `01-`, `02-`).

This is designed so you (or an agent) can just drop files in:

> To add a card, write a file to `command-tab-context/cards/`.

### Card types

The file declares a `type`:

- **`list`** — read-only rows. Items may include a `url` to become links.
- **`checklist`** — checkable items; toggling writes the state back to the file.
- **`note`** — freeform text; editing saves back to the file.
- **`input`** — a prompt + box that appends timestamped entries to a JSONL log
  and shows the most recent ones.
- **`table`** — read-only label/value rows (stats, key facts). JSON `items`
  (`{label, value}`), or a Markdown file with `type: table` and `Label: value`
  lines.

### JSON example (`03-habits.json`)

```json
{
  "title": "Habits",
  "type": "checklist",
  "accent": "#7c5cff",
  "items": [
    { "label": "Eat slowly", "detail": "No autopilot eating", "checked": false },
    { "label": "Bodyweight set", "checked": false }
  ]
}
```

### Markdown example (`02-study-focus.md`)

```markdown
---
type: note
title: Study Focus
accent: "#2f7d5b"
subtitle: One primary study at a time.
---
What is one mechanism I can explain clearly today?
```

Markdown is the most agent-friendly format. A Markdown file with `- [ ]` /
`- [x]` lines becomes a **checklist** automatically; otherwise it is a `note`.

### Input example (`01-gratitude.json`)

```json
{
  "title": "Gratitude",
  "type": "input",
  "subtitle": "What are you grateful for today?",
  "placeholder": "I am grateful for...",
  "log": "gratitude.jsonl"
}
```

Entries are appended to `command-tab-context/cards/gratitude.jsonl` as one JSON
object per line (`{"text": "...", "at": "ISO-8601"}`).

### Where cards are pulled from

By default the server reads the **primary** folder:

1. `COMMAND_TAB_CARDS_DIR` if set, else
2. `COMMAND_TAB_CONTEXT_DIR/cards`, else
3. `<cwd>/command-tab-context/cards`

The primary folder is **writable** (checking items, saving notes, appending
input entries edit those files).

### Pulling cards from other folders

To show cards that live elsewhere (an existing notes folder, an agent's output
directory, a shared journal), add extra sources two ways:

```bash
# env: comma-separated paths
COMMAND_TAB_CARDS_DIRS="~/work/cards,~/journal" npm run connector
```

```json
// command-tab-context/settings.json
{
  "card_sources": [
    "~/some/other/cards-folder",
    { "path": "~/my/private/journal", "readonly": false, "label": "Journal" }
  ]
}
```

**Safety:** extra sources are **read-only by default** — their cards render, but
the new tab shows no edit controls and the server refuses any write to them.
This means you can point Command Tab at another system's folder without risk of
modifying it. Opt into edits per source with `"readonly": false`. Missing
folders are silently skipped, and `~` expands to your home directory.

### Write-back endpoints

```text
GET  /api/cards         list all card connectors (handy for agents/debugging)
POST /api/cards/check   { "id": "card-03-habits", "index": 0, "checked": true }
POST /api/cards/note    { "id": "card-02-study-focus", "body": "..." }
POST /api/cards/input   { "id": "card-01-gratitude", "text": "..." }
```

Card ids are derived from the filename (`03-habits.json` -> `card-03-habits`).
Writes are validated to stay inside the `cards/` folder. A file that fails to
parse renders as an `error` card with the parse error — never faked content.

Starter cards live in [`examples/context/cards/`](../examples/context/cards/).

## Hamilton-Compatible Backend Surface

When `COMMAND_TAB_BACKEND_URL` is set, the connector server exposes the old local command-center API surface through the public Command Tab connector:

```text
GET  /api/tasks
GET  /api/task-note?id=...
GET  /api/task-agent?note_id=...
GET  /api/whatsapp/latest
GET  /api/whatsapp/latest-html
GET  /api/whatsapp/daily-plan
GET  /api/whatsapp/bridge-health
GET  /api/gmail/latest
GET  /api/automation-output/latest?slug=...
GET  /api/morning-brief
GET  /api/daily-shot/latest?limit=...
GET  /api/habits/today
GET  /api/vietnamese/today?offset=...
GET  /api/voice-notes/today
GET  /api/calendar/upcoming?hours=...
GET  /api/agent-runs?limit=...
GET  /api/agent-inbox?limit=...
GET  /api/memory/search?q=...&project=...&workspace=...&kind=...&include_code=...
POST /api/tasks/add
POST /api/tasks/check
POST /api/tasks/pin
POST /api/tasks/remind
POST /api/tasks/release-focus
POST /api/tasks/move-top
POST /api/tasks/move-bottom
POST /api/tasks/title
POST /api/tasks/note-append
POST /api/tasks/agent
POST /api/task-note
POST /api/whatsapp/refresh
POST /api/whatsapp/daily-plan
POST /api/whatsapp/daily-plan/send
POST /api/whatsapp/bridge-restart
POST /api/whatsapp/send
POST /api/gmail/refresh
POST /api/gratitude
POST /api/daily-shot/log
POST /api/habits/check
POST /api/vietnamese/study
POST /api/voice-notes/open
POST /api/voice-notes/open-folder
POST /api/memory/open
POST /api/memory/brief
POST /api/memory/reindex
POST /api/codex/open
```

WhatsApp send endpoints perform bridge-health preflight in the connector before forwarding. If the bridge is down, the request fails visibly with the preflight error.

## Summary Endpoint

`GET /api/summary`

```json
{
  "status": "ok",
  "source": "template",
  "generated_at": "2026-06-06T12:00:00.000Z",
  "connectors": [
    {
      "id": "tasks",
      "label": "Tasks",
      "kind": "local",
      "status": "ok",
      "source": "live",
      "source_file": "/path/to/tasks.json",
      "items": [
        {
          "title": "Review the connector contract",
          "detail": "high · due today · Open docs/connectors.md"
        }
      ]
    }
  ]
}
```

## Local Tasks Connector

Default:

```bash
npm run connector
```

Uses the first available:

```text
COMMAND_TAB_TASKS_FILE
./command-tab-context/tasks.json
examples/tasks.sample.json
```

Use your own task file:

```bash
COMMAND_TAB_TASKS_FILE=/absolute/path/to/tasks.json npm run connector
```

Accepted shapes:

```json
[
  { "title": "Task one", "detail": "Optional detail", "priority": "high", "status": "todo", "due": "today" }
]
```

or:

```json
{
  "tasks": [
    { "title": "Task one", "detail": "Optional detail", "priority": "high", "status": "todo" }
  ]
}
```

Tasks with `status` set to `done`, `completed`, or `archived` are hidden from the card.

## Local WhatsApp / Message Draft Context

This is not a live WhatsApp connector yet. It is a local context file for drafts and status visibility.

```text
command-tab-context/whatsapp.json
```

Shape:

```json
{
  "chats": [
    {
      "id": "family",
      "name": "Family",
      "purpose": "Daily warm note",
      "message": "Good morning.",
      "status": "draft",
      "last_sent_at": ""
    }
  ]
}
```

Future live WhatsApp sending must check bridge health and require explicit user approval.

## Local Notes Context

```text
command-tab-context/notes.json
```

Shape:

```json
{
  "notes": [
    {
      "id": "note-1",
      "title": "Principle",
      "body": "Show failures clearly.",
      "tags": ["safety"]
    }
  ]
}
```

## Native Google Connectors (OAuth)

These are the first **real, standalone** connectors. They talk to Google
directly from the local connector server and do **not** require the external
backend. Both are read-only:

- **Calendar** — upcoming events.
- **Gmail** — recent messages (default query `in:inbox is:unread newer_than:14d`,
  override with `COMMAND_TAB_GMAIL_QUERY`).

They are dependency-free: OAuth (PKCE), token refresh, and the API calls all use
Node's built-in `fetch`, `crypto`, and `fs`. Each service has its own scope and
its own token file (`google-<service>-token.json`), so existing per-scope tokens
can be reused.

### 1. Create your own Google OAuth client

In your own Google Cloud project:

1. Enable the **Google Calendar API**.
2. Create an **OAuth client ID** of type **Desktop app** (loopback redirect).
3. Add the scope `https://www.googleapis.com/auth/calendar.readonly`.

The connector uses the redirect URI `http://127.0.0.1:8733/api/google/callback`.
A Desktop-app client allows loopback redirects, so no extra registration is
needed.

### 2. Give the connector your client credentials

Either set environment variables:

```bash
COMMAND_TAB_GOOGLE_CLIENT_ID=...apps.googleusercontent.com \
COMMAND_TAB_GOOGLE_CLIENT_SECRET=... \
npm run connector
```

Or drop the downloaded client JSON into your gitignored context folder:

```text
command-tab-context/google-credentials.json
```

It accepts the standard Google shape (`{ "installed": { ... } }` or
`{ "web": { ... } }`).

### 3. Connect from the new tab

Open a new tab. The Calendar and Gmail cards show **disconnected** with a
**Connect** button each. Click one:

1. The server redirects you to Google's consent screen for that scope.
2. After you approve, Google redirects back to
   `http://127.0.0.1:8733/api/google/callback`.
3. The refresh token is saved to
   `command-tab-context/google-<service>-token.json` (gitignored, `0600`).
4. Refresh the new tab — events / messages appear.

Calendar and Gmail authorize separately (separate scopes, separate token
files), so you can connect one without the other.

### Configuration reference

| Variable | Default | Purpose |
| --- | --- | --- |
| `COMMAND_TAB_GOOGLE_CLIENT_ID` | — | OAuth client id (overrides file) |
| `COMMAND_TAB_GOOGLE_CLIENT_SECRET` | — | OAuth client secret |
| `COMMAND_TAB_GOOGLE_CREDENTIALS` | `command-tab-context/google-credentials.json` | Client JSON file path |
| `COMMAND_TAB_GOOGLE_CALENDAR_TOKEN_FILE` | `command-tab-context/google-calendar-token.json` | Calendar token |
| `COMMAND_TAB_GOOGLE_GMAIL_TOKEN_FILE` | `command-tab-context/google-gmail-token.json` | Gmail token |
| `COMMAND_TAB_GOOGLE_CALENDAR_ID` | `primary` | Calendar to read |
| `COMMAND_TAB_GMAIL_QUERY` | `in:inbox is:unread newer_than:14d` | Gmail search query |

Reusing existing tokens: if you already have google-auth (Python) format tokens
(they embed `client_id`/`client_secret`/`refresh_token`), just copy them to the
token paths above — no separate credentials file needed. The connector reads
that format and never writes back to the original files.

### Endpoints

```text
GET /api/google/connect?scope=calendar.readonly   # starts consent (302 to Google)
GET /api/google/connect?scope=gmail.readonly      # same, for Gmail
GET /api/google/callback                           # OAuth redirect target
GET /api/calendar/upcoming?hours=12                # native upcoming events (local mode)
GET /api/gmail/latest?q=...                        # native recent messages (local mode)
```

In external-backend mode, `/api/calendar/upcoming` and `/api/gmail/latest`
continue to proxy the backend instead of calling Google directly.

### Failure states

- No client configured -> `disconnected` with setup instructions.
- Client configured, not authorized -> `disconnected` with a Connect action.
- Live API call fails -> `error` with the real error message. Never a cached or
  fake list.

## Status Rules

- `ok`: live connector data.
- `cached`: intentionally stale/cached data.
- `template`: sample or placeholder data.
- `disconnected`: connector is not configured.
- `error`: connector attempted a live call and failed.

The extension must show these states clearly.

## Connector Settings (extension)

The new tab has a **Settings** panel (in the Command Center header) for:

- the connector server URL (defaults to `http://127.0.0.1:8733`),
- an optional Codex workspace path,
- **per-connector show/hide toggles** — uncheck a connector to hide its card.

Visibility is stored in the browser (`localStorage`, key
`command-tab:hidden-connectors`); the connector server is unaffected.

## Next Real Connectors

Shipped: native Google Calendar + Gmail (read-only); local tasks/notes/WhatsApp
context; external-backend compat for the rest.

Remaining, recommended order:

1. Local model adapter (summaries, ranking, drafts).
2. Native Google Drive read-only (recent files), same OAuth path.
3. Multi-source daily-systems polish in standalone mode.
