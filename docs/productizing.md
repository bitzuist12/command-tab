# Productizing — WhatsApp, local-first

The product is a **local Mac app** that reads your WhatsApp and shows "needs
reply / summary / pending" cards. The defining principle:

> **It's a local app that phones home only to summarize — and by default, not
> even then.** Your messages never leave the machine.

## The decisions (locked)

1. **Local-first, forced.** The WhatsApp session needs a persistent local
   process (Baileys), so a pure web app can't hold it. Hosting sessions in the
   cloud would mean holding everyone's WhatsApp — the liability we refuse. The
   bridge and raw messages stay on the device.

2. **Read-only.** We never send. Incoming messages are read to summarize; that's
   it. This removes the spam-ban risk and the worst of the ToS exposure.

3. **On-device summarization by default.** A small (~3B) local model summarizes
   everything on the machine via **llama.cpp**. Nothing leaves. This is the
   default because WhatsApp is private enough that *even the user* shouldn't have
   to trust a server.
   - Model: `Qwen2.5-3B-Instruct` (or `Llama-3.2-3B`) at Q4 (~2 GB, ~3–4 GB RAM).
   - Runs on **any Apple Silicon Mac (M1+, even 8 GB)** in real time.
   - Validated: on the summarize-and-tag task a small model gets the
     reply-direction (you vs them) right; pair it with deterministic pending-ask
     heuristics so the "needs reply" signal never depends solely on the model.

4. **Hosted is optional, not default.** For users who want a bigger model, a
   thin **no-retention** endpoint on Railway can run `gpt-oss-120b` via
   OpenRouter (~$0.002 per inbox refresh; the product pays, users don't). Same
   model family as a local `gpt-oss-20b` if desired. It is opt-in.

5. **Bridge: Baileys for the product.** No browser, lighter, no detached-frame
   failures. The Chromium (`whatsapp-web.js`) bridge stays for personal/local
   use. Both expose the same HTTP contract, so they're interchangeable.

6. **Distribution: Tauri + Developer ID notarization. Not the App Store.**
   Notarization is an automated malware scan (minutes, CI), not human review —
   and a WhatsApp-automation app wouldn't pass App Review anyway. $99/year +
   one-time CI setup, then automatic. Beta first via unsigned/Homebrew for
   technical users; notarize for the consumer launch.

## The stack

```
Baileys bridge (local, read-only)
   → app (Tauri)  →  summarizer  →  llama.cpp + 3B model (LOCAL, on-device)
                                    └ or OpenRouter gpt-oss-120b (opt-in, no-store)
   → "needs reply / summary / pending" cards
```

## What exists

- `whatsapp-bridge/` — Baileys read-only bridge (`/chats`, `/messages`, `/digest`).
- `summarizer-backend/` — OpenAI-compatible summarizer; endpoint-configurable, so
  the same code runs against local llama.cpp **or** OpenRouter. `npm run
  on-device` runs the whole local stack in one command.
- `desktop/` — the Tauri app (defaults to the local summarizer on :8090).

## Next build steps

1. **Bundle** llama.cpp + the 3B model as a Tauri sidecar (download-on-first-run)
   so a normal user just opens the app — no llama.cpp install, no command.
2. **Heuristic backstop** for the "needs reply" tag.
3. **Incremental** summarization (only chats with new activity) to keep it fast.
4. **Notarize** for distribution.
