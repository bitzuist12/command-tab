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

When a backend URL is configured, `/api/summary` attempts compatible backend calls for tasks, WhatsApp bridge/daily plan/latest review, Gmail latest review, calendar upcoming, habits, voice notes, and agent runs. Each failed call returns an explicit `error` connector instead of sample content.

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

## Status Rules

- `ok`: live connector data.
- `cached`: intentionally stale/cached data.
- `template`: sample or placeholder data.
- `disconnected`: connector is not configured.
- `error`: connector attempted a live call and failed.

The extension must show these states clearly.

## Next Real Connectors

Recommended order:

1. Task actions: quick-add, check, pin, remind, note append.
2. WhatsApp bridge restart and manual-send queue.
3. Gmail review actions: search, sort, reviewed/later, block sender, copy reply.
4. Daily systems cards: habits, gratitude, voice notes, daily shot.
5. Local model adapter.
