# Connectors

Command Tab uses an optional connector server instead of putting Gmail, WhatsApp, Calendar, filesystem, or model credentials in browser extension code.

## Local Development

```bash
npm run connector
```

Then open:

```text
http://127.0.0.1:8733/api/health
http://127.0.0.1:8733/api/summary
```

The current server includes one real local connector: Tasks. By default it reads `examples/tasks.sample.json`. You can point it at your own local task file with `COMMAND_TAB_TASKS_FILE`.

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

Uses:

```text
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

## Status Rules

- `ok`: live connector data.
- `cached`: intentionally stale/cached data.
- `template`: sample or placeholder data.
- `disconnected`: connector is not configured.
- `error`: connector attempted a live call and failed.

The extension must show these states clearly.

## Next Real Connectors

Recommended order:

1. Google Calendar read-only.
2. Gmail read-only digest.
3. WhatsApp bridge health and manual-send queue.
4. Local model adapter.
