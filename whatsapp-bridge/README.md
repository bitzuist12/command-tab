# Command Tab WhatsApp Bridge (Baileys)

A **read-only** WhatsApp bridge that speaks the WhatsApp multi-device WebSocket
protocol via [Baileys](https://github.com/WhiskeySockets/Baileys) — **no browser**.
This is the productization track described in
[docs/whatsapp-connector.md](../docs/whatsapp-connector.md). It implements the
same local HTTP contract as the Chromium bridge, so Command Tab can read from
either one.

It **never sends**. Incoming messages are kept in memory only, to build the
digest a summarizer agent turns into "needs reply / summary / tags" cards.

## Run

```bash
cd whatsapp-bridge
npm install
npm start
```

On first run, scan the QR with WhatsApp → **Settings → Linked Devices → Link a
Device**. The session is saved to `auth_info/` (gitignored) and persists across
restarts. Default port is **8003**, so it can run alongside a Chromium bridge on
8002 for side-by-side comparison.

Config via env: `BRIDGE_PORT`, `WHATSAPP_AUTH_DIR`.

## HTTP API (127.0.0.1 only)

```text
GET /health                                    { ready, waiting_for_qr, chats }
GET /chats                                     recent chats
GET /messages?chat=JID&days=3&limit=100         messages in a chat (windowed)
GET /digest?days=7&max_chats=25&msgs_per_chat=15   1:1 chats active in window
```

Returns `503` until the WhatsApp session is ready (QR scanned).

## Notes / known limits of this spike

- **History depth**: Baileys backfills recent history on first connect
  (`syncFullHistory: true`); very old messages may not be present. The store is
  in-memory and rebuilds on restart from the next sync. (A persisted store can
  be added later.)
- **Read-only**: no `/send`. Sending stays manual/approval-based and is out of
  scope here.
- **Unofficial**: like all WhatsApp Web clients, this is reverse-engineered.
  Read-only keeps the practical risk benign.

## Next step

Add a Command Tab connector that calls `/digest`, runs it through a summarizer
on the user's own API key, and emits "needs reply / summary / tags" cards.
