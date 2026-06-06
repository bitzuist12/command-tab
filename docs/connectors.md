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

The current server returns template/disconnected connector cards only. That is intentional. Template content must be labeled as `template`, and disconnected services must not look live.

## Summary Endpoint

`GET /api/summary`

```json
{
  "status": "ok",
  "source": "template",
  "generated_at": "2026-06-06T12:00:00.000Z",
  "connectors": [
    {
      "id": "gmail",
      "label": "Gmail",
      "kind": "oauth",
      "status": "disconnected",
      "source": "none",
      "error": "Gmail is not connected.",
      "items": []
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

1. Local tasks from a JSON file.
2. Google Calendar read-only.
3. Gmail read-only digest.
4. WhatsApp bridge health and manual-send queue.
5. Local model adapter.
