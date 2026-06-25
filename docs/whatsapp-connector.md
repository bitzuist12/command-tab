# WhatsApp Connector

Command Tab reads WhatsApp through a **local bridge** — a small process on the
user's own machine that holds the WhatsApp session and exposes a localhost HTTP
API. The extension and connector server never talk to WhatsApp directly; they
talk to this bridge.

The important design choice: **the bridge is defined by its HTTP contract, not
its implementation.** Two implementations can sit behind the same contract — a
Chromium-based one (proven, what we run locally today) and a Baileys-based one
(the productization track). Swapping one for the other does not change the
connector.

## Bridge contract (HTTP, `127.0.0.1` only)

```text
GET  /chats                                   list recent chats
GET  /messages?chat=ID&days=3&limit=100        messages in a chat (windowed)
GET  /digest?days=7&max_chats=25&msgs_per_chat=15   1:1 chats active in window
POST /send   { "chat": "ID", "text": "..." }   send (manual / approval only)
```

- `/chats` → `[{ id, name, isGroup, unread, lastMessage, timestamp }]`
- `/messages` → `{ chat, id, messages: [{ fromMe, from, body, timestamp, time }] }`
- `/digest` → `{ days, generated, chats: [{ name, id, unread, messages: [...] }] }`
- `/send` → `{ ok: true }` or `{ error }`. Returns `503` until the session is ready.

`/digest` is the summarization feed: the messages a summarizer agent turns into
"needs reply / summary / tags" cards.

**Read-only by default:** incoming messages are logged, never auto-replied.
Sending is manual and approval-based only. The product does not auto-send.

## Mode A — Local Chromium bridge (proven, what we run today)

Stack: [`whatsapp-web.js`](https://github.com/pedroslopez/whatsapp-web.js) +
`puppeteer-core`. A headless browser logged into WhatsApp Web, exposing the
contract above.

Why it works well for a single power user:

- **Reuses the installed Chrome** via `puppeteer-core` (`executablePath` →
  the system Chrome), so there is no separate ~200 MB Chromium download.
- **Session persistence** (`LocalAuth`): scan the QR **once**; the session is
  saved to disk and survives restarts.
- **Run under a supervisor** (launchd on macOS, pm2/systemd elsewhere) that
  auto-restarts on crash. A detached-frame/browser crash then self-heals in
  seconds and is invisible in normal use.

Trade-offs:

- Each session runs a full **headless browser** (RAM, occasional Chromium
  crashes — the "detached Frame" failure class).
- Bundling/launching a browser inside a signed, click-to-run app for
  non-technical users is fiddly (Chrome path, sandbox flags, Gatekeeper).

**Decision: keep Mode A for the local/personal setup.** It is reliable enough
with persisted auth + a supervisor, and it is already running.

## Mode B — Baileys bridge (productization track, to evaluate)

Stack: [`@whiskeysockets/baileys`](https://github.com/WhiskeySockets/Baileys).
Speaks the WhatsApp multi-device **WebSocket protocol directly — no browser.**
Same QR-link-once model, but lighter and with no frame-crash class. This is
what Hermes (Nous Research) uses for its WhatsApp gateway.

Why it is the better base for a shipped app:

- **No Chromium** → far less RAM, no browser to bundle/launch, no detached-frame
  failures. Much easier to package as a one-click signed app.
- Native reconnection handling; a single lightweight background process.
- Same scan-once onboarding (the entire setup is one QR scan).

Scope for the product:

- **Read-only**: implement `/chats`, `/messages`, `/digest`. Defer `/send`
  (or keep it manual/approval-only). Read-only removes the spam-ban risk.
- **Summaries via a hosted endpoint the product runs** (not BYO key — asking a
  normal user for an API key loses ~99% of them). See "Summarization & hosting".
- Transcribe voice notes (e.g. Whisper) so they are summarized too.

## Summarization & hosting (decision)

The product provides the AI. Users do **not** bring their own API key. The local
app calls a **hosted summarization endpoint** that runs the model.

That means message text transits the server to be summarized, so the trust story
depends on three rules:

1. **No retention.** Summarize and discard. Store the resulting summary/tags
   (ideally back on the user's device), never the raw message text.
2. **Send the minimum.** Raw messages stay on the device (the bridge holds
   them). Ship only the recent text needed for the summary — no media; strip
   numbers/names where possible.
3. **Cost + abuse control.** Per-install auth token, rate limits, and
   **incremental** summarization (only re-summarize chats with new activity —
   the 7-day rolling pipeline already fits this). A cheap-but-good model tier.

The summarizer brain already exists (per-chat 7-day structured summary: action
label / pending-from-you-vs-them / topics / suggestion / confidence, plus
heuristics and an honest fallback). Productizing it = expose it as a thin
authenticated, no-store, incremental endpoint; the local app POSTs the digest
and renders the returned tags as cards.

Open questions to answer with a spike:

- Reliability of Baileys session persistence vs `LocalAuth` over weeks.
- Re-link frequency and how gracefully it reconnects.
- Group-chat coverage and message history depth vs the browser approach.

## Comparison

| | Mode A: Chromium (`whatsapp-web.js`) | Mode B: Baileys |
| --- | --- | --- |
| Transport | Headless browser (WhatsApp Web) | WebSocket protocol, no browser |
| Resource use | Heavy (full Chrome) | Light |
| Failure class | Detached frame / browser crash | Socket reconnects |
| Packaging for others | Fiddly (bundle/launch a browser) | Clean (single process) |
| Onboarding | Scan QR once | Scan QR once |
| Status | **Proven — keep for local** | **Try for the product** |

Both are unofficial (reverse-engineered WhatsApp Web). Read-only summarization
keeps the practical risk benign; do not auto-send.

## Plan

1. Keep Mode A as the local/personal bridge (no changes needed).
2. ✅ Baileys read-only spike built — [`whatsapp-bridge/`](../whatsapp-bridge/)
   (port 8003, same `/chats` `/messages` `/digest` contract). Run with
   `cd whatsapp-bridge && npm install && npm start`, scan the QR once.
3. Run both for a while; compare reliability/onboarding.
4. If Baileys holds up, add a Command Tab connector that calls `/digest`, sends
   it to the **hosted no-store summarizer**, and emits "needs reply / summary /
   tags" cards — then make it the default bridge for the packaged app.
