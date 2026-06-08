# Onboarding

Command Tab works as a tab manager immediately. To turn it into a command center, create a private context folder and run the connector server.

## 1. Install The Extension

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click **Load unpacked**.
4. Select the `extension/` folder.
5. Open a new tab.

## 2. Create A Private Context Folder

```bash
cp -R examples/context ./command-tab-context
```

`command-tab-context/` is gitignored. This is where your personal tasks, notes, message drafts, and settings live.

## 3. Edit Your First Files

Tasks:

```text
command-tab-context/tasks.json
```

WhatsApp/message drafts:

```text
command-tab-context/whatsapp.json
```

Notes:

```text
command-tab-context/notes.json
```

## 4. Start The Connector Server

```bash
npm run connector
```

Open:

```text
http://127.0.0.1:8733/api/summary
```

The extension reads that endpoint and renders the connector cards.

## 5. Use A Different Context Folder

```bash
COMMAND_TAB_CONTEXT_DIR=/absolute/path/to/my-command-tab-context npm run connector
```

## 6. Optional: Connect Google Calendar

Command Tab can read your upcoming events directly (read-only), without the
external backend:

1. Create your own Google OAuth **Desktop app** client and enable the
   Calendar API.
2. Put the client JSON at `command-tab-context/google-credentials.json`
   (or set `COMMAND_TAB_GOOGLE_CLIENT_ID` / `COMMAND_TAB_GOOGLE_CLIENT_SECRET`).
3. Open a new tab and click **Connect Google Calendar** on the Calendar card.

Tokens are stored in `command-tab-context/google-token.json` (gitignored).
See [connectors.md](connectors.md) for the full setup.

## 7. Safety Rules

- Do not commit your real context folder.
- Do not put access tokens or passwords in browser extension files.
- Message drafts are drafts. Future send connectors must require explicit approval.
- If Gmail, WhatsApp, Calendar, or local AI fails, the card must show the failure state.
