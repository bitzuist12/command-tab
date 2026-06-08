# Migration Inventory

This tracks the migration from Ata's Hamilton-backed Tab Out prototype into the public Command Tab repo.

The goal is to move the product behavior into Command Tab without copying private Hamilton data, hardcoded personal paths, tokens, Gmail content, WhatsApp messages, or local-only secrets.

## Current Migration Layer

Command Tab now supports two connector modes:

- Local context mode: reads gitignored `command-tab-context/`.
- External backend mode: set `COMMAND_TAB_BACKEND_URL` to a local backend that implements compatible endpoints.

For Ata's existing Hamilton prototype:

```bash
COMMAND_TAB_BACKEND_URL=http://127.0.0.1:8765 npm run connector
```

## Migrated Into Command Tab

- Public product repo, docs, license attribution, and roadmap.
- Optional local connector server on `127.0.0.1:8733`.
- Private context folder convention.
- Local read-only task, WhatsApp/message draft, and notes cards.
- Backend compatibility summary for:
  - tasks
  - WhatsApp bridge health
  - WhatsApp daily-plan status
  - WhatsApp latest review items
  - Gmail latest review items
  - calendar upcoming items
  - habits, voice notes, and agent runs summary
- Generic backend proxy route under `/api/backend/...`.
- Direct Hamilton-compatible backend routes for task notes, task agents, WhatsApp latest/latest HTML/daily plan/bridge health/refresh, Gmail latest/refresh, morning brief, automation outputs, daily shot, habits, Vietnamese study, voice notes, calendar, agent runs/inbox, memory search/open/brief/reindex, and Codex open.
- Task add from the tab UI via `/api/tasks/add`.
- Task check, pin, remind, release-focus, note append, title, and agent action routes.
- Task card controls for check, pin, remind, later, note, and agent.
- Task-to-WhatsApp modal with manual send and connector-side bridge preflight.
- Top/focus task presentation and nudge detection.
- WhatsApp bridge restart action with explicit restart diagnostics.
- WhatsApp daily-plan mini-card with inline draft review and manual send.
- WhatsApp daily-plan sends use a connector-side bridge health preflight.
- WhatsApp review card with search, Reviewed, and Later local state.
- Gmail review card with search, Reviewed, Later, Block sender, and Copy local actions.
- WhatsApp/Gmail review sorting.
- Gmail review task creation.
- Daily Systems card with habit check controls, gratitude save, Vietnamese study, daily shot save, voice note open/folder, and agent run rows.
- Habit metric entry/save.
- Voice note playback for latest note text.
- Richer Calendar card for upcoming events.
- Agent Inbox card with status/detail rows and open-run actions.
- Expandable detail panes for Gmail/WhatsApp review rows and Agent Inbox rows.
- Memory Search card with backend search, open-result, brief, and reindex actions.
- Editable local Notes card with save/delete.
- Connector settings UI for the local connector URL plus setup command hints.
- Codex open bridge through `POST /api/codex/open`, with the local workspace path stored in browser storage instead of hardcoded in the public repo.
- Clear `ok`, `template`, `disconnected`, and `error` states.

## Native Standalone Connectors (Phase 2)

These do not depend on the external Hamilton backend:

- Google Calendar read-only connector via the connector server's own OAuth
  (PKCE, dependency-free). One-click connect from the new tab, tokens stored in
  the gitignored context folder, explicit `disconnected`/`error` states.
  Implemented in [connector-server/google.js](../connector-server/google.js).

## Still To Migrate

- No known old Tab Out / Hamilton command-center parity gaps remain in this inventory.
- Future product work: package the connector, add screenshots, add contribution docs, and continue replacing Hamilton-specific assumptions with public connector contracts.

## Migration Principle

Do not copy the Hamilton-specific extension file wholesale. Extract behavior into:

1. A public connector contract.
2. Small frontend cards that work against that contract.
3. Optional private adapters, configured by URL or environment variable.

If a backend call fails, show the exact failure state. Do not silently fall back to samples.
