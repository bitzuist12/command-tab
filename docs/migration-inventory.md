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
- Clear `ok`, `template`, `disconnected`, and `error` states.

## Still To Migrate

- Top/focus task UI.
- Task quick-add.
- Task check, pin, remind, release-focus, and note append actions.
- Task-to-WhatsApp modal.
- Task-to-agent action.
- Full WhatsApp daily-plan mini-card with inline draft review and manual send.
- WhatsApp bridge restart button.
- WhatsApp manual send with preflight health check.
- WhatsApp review search, sort, select, reviewed, and later actions.
- Gmail review search, sort, select, reviewed, later, block-sender, copy-reply, and task creation actions.
- Calendar card UI beyond summary rows.
- Gratitude card.
- Habits check/save UI.
- Vietnamese study card.
- Voice notes open/play surfaces.
- Daily shot card.
- Agent inbox and latest agent-run UI.
- Memory/project search surfaces.
- Editable note cards.
- Connector settings UI.

## Migration Principle

Do not copy the Hamilton-specific extension file wholesale. Extract behavior into:

1. A public connector contract.
2. Small frontend cards that work against that contract.
3. Optional private adapters, configured by URL or environment variable.

If a backend call fails, show the exact failure state. Do not silently fall back to samples.
