# Command Tab Context Folder

Copy this folder to a private location and point Command Tab at it:

```bash
cp -R examples/context ~/command-tab-context
COMMAND_TAB_CONTEXT_DIR=~/command-tab-context npm run connector
```

Files in this folder are local user context. Do not commit your real context folder.

Expected files:

- `tasks.json`
- `whatsapp.json`
- `notes.json`
- `settings.json`
- `cards/` -- custom cards; every `.json`/`.md` file becomes a card (see
  [docs/connectors.md](../../docs/connectors.md#custom-cards-drop-a-file-get-a-card))

Optional (for native Google connectors, see [docs/connectors.md](../../docs/connectors.md)):

- `google-credentials.json` -- your own OAuth client (or use env vars)
- `google-calendar-token.json` -- written after you connect Calendar
- `google-gmail-token.json` -- written after you connect Gmail

These hold credentials/tokens and must never be committed.
