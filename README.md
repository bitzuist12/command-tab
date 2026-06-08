# Command Tab

**A private command center that opens every time you open a new tab.**

Command Tab is a Chrome new-tab extension for turning the browser's most repeated moment into an operating surface: open tabs, saved links, tasks, inboxes, calendar, messages, notes, and optional local AI.

This repo is an open-source fork of [Tab Out](https://github.com/zarazhangrui/tab-out) by Zara Zhang. The first public version keeps the excellent tab-cleanup foundation and starts evolving it toward a connector-based command center.

## Current State

Today, Command Tab is a pure Chrome extension:

- Groups open tabs by domain.
- Pulls common homepages into a cleanup group.
- Jumps directly to any tab across Chrome windows.
- Closes duplicates and whole domain groups.
- Saves tabs for later in `chrome.storage.local`.
- Supports local personal configuration through `extension/config.local.js`.
- Optionally reads connector cards from a local server at `http://127.0.0.1:8733`.

## Product Direction

Command Tab is moving toward:

- **New-tab command center:** a dashboard that is always one keystroke away.
- **Bring-your-own connectors:** Gmail, Google Calendar, WhatsApp, tasks, notes, files, and eventually other systems.
- **Privacy-first defaults:** local storage first, explicit connector authorization, no silent external calls.
- **Optional local AI:** small local models for summarizing, ranking, drafting, and routing, with cloud AI only when the user chooses it.
- **Open extension + optional local app:** extension for the new-tab surface; local/server app for connectors that need credentials, OAuth, or filesystem access.

The intended architecture is:

```text
Chrome new tab extension
  -> local connector server or hosted connector API
  -> user-authorized services: Gmail, Calendar, WhatsApp, tasks, files
  -> optional model layer: local Gemma/Ollama/llama.cpp or user-provided cloud API keys
```

See [docs/architecture.md](docs/architecture.md) and [docs/roadmap.md](docs/roadmap.md).

For first-time setup, see [docs/onboarding.md](docs/onboarding.md).

## Why A New Tab?

Most productivity apps fail because you have to remember to open them. A new-tab surface appears naturally dozens of times per day. That makes it a good place for:

- the next thing to do
- urgent replies
- calendar context
- tabs you can close
- drafts that need approval
- personal reminders
- lightweight AI summaries

## Install For Development

1. Clone the repo:

```bash
git clone https://github.com/bitzuist12/command-tab.git
cd command-tab
```

2. Load the extension:

- Open Chrome and go to `chrome://extensions`
- Enable **Developer mode**
- Click **Load unpacked**
- Select the `extension/` folder

3. Open a new tab.

No build step is required for the current extension.

## Optional Connector Server

Create a private context folder:

```bash
cp -R examples/context ./command-tab-context
```

Run the local connector server:

```bash
npm run connector
```

Then Command Tab will read:

```text
http://127.0.0.1:8733/api/summary
```

The connector server reads `./command-tab-context/` when present. You can also point it at another private folder:

```bash
COMMAND_TAB_CONTEXT_DIR=/absolute/path/to/context npm run connector
```

To migrate an existing local dashboard backend, point Command Tab at that backend:

```bash
COMMAND_TAB_BACKEND_URL=http://127.0.0.1:8765 npm run connector
```

This enables backend-backed cards for tasks, WhatsApp bridge/daily plan, Gmail review, calendar, daily systems, memory search/briefs, Codex open, and agent runs when those endpoints exist. Failed backend calls are shown as `error`; they are not replaced with fake content.

The local Tasks connector can still be pointed at a single file:

```bash
COMMAND_TAB_TASKS_FILE=/absolute/path/to/tasks.json npm run connector
```

Other external-service connectors still return clearly labeled `disconnected` states. This is deliberate: fake/sample connector content must be labeled clearly and never presented as real Gmail, WhatsApp, Calendar, or model output.

See [docs/connectors.md](docs/connectors.md).

## Local Personal Config

You can create `extension/config.local.js` for personal overrides. This file is gitignored.

Example:

```js
window.LOCAL_LANDING_PAGE_PATTERNS = [
  { label: 'Gmail', pattern: /^https:\/\/mail\.google\.com\// },
  { label: 'Calendar', pattern: /^https:\/\/calendar\.google\.com\// },
];
```

Do not commit tokens, secrets, personal messages, or private workspace paths.

## Development Checks

```bash
npm run check
```

## Open-Source Notes

- This project preserves the upstream MIT license and attribution to Tab Out by Zara Zhang.
- Command Tab will stay open source.
- Connector implementations should be explicit about permissions and failure states.
- No connector should pretend a failed Gmail/WhatsApp/API/model call succeeded.

## License

MIT. See [LICENSE](LICENSE).
