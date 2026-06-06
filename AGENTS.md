# AGENTS.md -- Command Tab

Command Tab is an open-source fork of Tab Out. It is being productized from a tab-cleanup new-tab extension into a privacy-first command center with optional connectors and local AI.

## Important Boundaries

- Do not copy Ata's private Hamilton code, file paths, WhatsApp messages, Gmail data, tokens, or personal configuration into this public repo.
- Use `extension/config.local.js` for private/local overrides. It is gitignored.
- Keep connector credentials out of browser code.
- For Gmail, Google Calendar, WhatsApp, filesystem, and model calls, prefer a separate local connector server or explicit hosted API rather than direct extension code.
- Failed connector/model calls must be visible. Do not show stale or fallback content as if it came from the real service.
- Preserve upstream attribution and MIT license.

## Current Structure

- `extension/manifest.json` -- Chrome Manifest V3 config.
- `extension/index.html` -- new-tab shell.
- `extension/app.js` -- tab grouping, saved-for-later, notes, UI behavior.
- `extension/style.css` -- dashboard styling.
- `docs/architecture.md` -- target product architecture.
- `docs/roadmap.md` -- staged product roadmap.

## Verify

```bash
node --check extension/app.js
```

For a visual check, load `extension/` as an unpacked Chrome extension and open a new tab.

## Product Direction

Build the smallest useful open-source product first:

1. Keep the tab-management workflow excellent.
2. Add a connector API contract without hardcoding one person's local system.
3. Add optional Gmail/Calendar/WhatsApp connectors behind a local server.
4. Add an optional local model adapter for summary/ranking/drafting.
5. Package installation so non-technical users can run it.

## Naming

Working name: **Command Tab**.

If renaming later, update:

- `README.md`
- `extension/manifest.json`
- `extension/index.html`
- footer links / docs
- GitHub repo metadata
