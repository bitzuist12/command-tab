# Command Tab Architecture

Command Tab should stay useful as a simple Chrome extension while growing into a connector-based command center.

## Layers

```text
Chrome extension
  - new-tab UI
  - tab/window APIs
  - saved links and lightweight notes
  - connector cards rendered from a typed local API

Connector server
  - OAuth and credentials
  - Gmail / Calendar / WhatsApp / task integrations
  - local filesystem access when explicitly enabled
  - model adapters
  - health and failure reporting

Model layer
  - optional local model: Ollama, llama.cpp, Gemma-family models
  - optional cloud model: user-provided API keys
  - no-AI mode for users who only want the dashboard
```

## Why Split Extension And Connector Server?

Browser extension code is inspectable and permission-sensitive. It is a poor place to put credentials, OAuth refresh tokens, filesystem access, or service-specific bridge logic.

The extension should:

- own the new-tab UI
- own Chrome tab management
- call explicit connector endpoints
- show health and failure states

The connector server should:

- own credentials
- perform external-service calls
- cache/source data
- return typed responses
- report failures with service, endpoint, status code, and error

## Connector Contract

Each connector should expose:

```json
{
  "id": "gmail",
  "label": "Gmail",
  "status": "ok | degraded | disconnected | error",
  "generated_at": "2026-06-06T12:00:00Z",
  "source": "live | cached | fallback | template",
  "error": null,
  "cards": []
}
```

Rules:

- If a connector call fails, set `status: "error"` and include the error.
- If stale or cached data is shown, label it as `cached`.
- If template/example content is shown, label it as `template`.
- Never present fallback content as live service output.

## Candidate Connectors

| Connector | First useful card | Notes |
| --- | --- | --- |
| Gmail | Needs reply / urgent threads | Requires OAuth scopes and careful Google app review if public |
| Google Calendar | Next meetings / conflicts | Safer than Gmail; good first OAuth connector |
| WhatsApp | Needs reply / manual send queue | Local WhatsApp Web bridge is useful but fragile; official Business API is separate |
| Tasks | Today's focus and quick capture | Can start with local JSON/Markdown before third-party APIs |
| Files/notes | Recent docs and search | Local-only mode is powerful but must be explicit |
| Local AI | Summaries, ranking, drafts | Optional, never required for core UX |

## Local AI

Local models are best for:

- summarizing inbox/thread context
- classifying urgency
- drafting replies for approval
- ranking what to do next
- summarizing notes or tabs

They should not silently:

- send messages
- mutate external systems
- make high-stakes recommendations without source visibility
- hide API/model failures behind generic text

## Packaging Direction

Start simple:

1. Chrome extension only.
2. Optional local connector server for developers.
3. Packaged desktop helper later for non-technical users.
4. Optional hosted connector backend only after auth/security is clear.

## Privacy

Command Tab should be explicit about where data lives:

- extension storage
- local connector server
- user's authorized services
- optional local model
- optional cloud model

No telemetry or external calls should be added without a clear setting and documentation.
