# Command Tab — WhatsApp (desktop app)

A local **Tauri** app for the WhatsApp review experience: read the local Baileys
bridge `/digest`, send it to the hosted summarizer, and show "needs reply /
summary / pending" cards — mirroring the Hamilton WhatsApp review.

The architecture: **everything local except summaries.** The WhatsApp session
and raw messages stay on the machine (the bridge); only the digest is sent to
the summarizer backend. Network calls are made from Rust (`run_pipeline`), so
there are no webview CORS/ATS issues.

## Run (dev)

Requires Rust (`rustup`) and Node.

```bash
cd desktop
npm install        # Tauri CLI
npm run dev        # opens the app window
```

The app opens showing **demo data** so you can see the UI immediately. To go
live:

1. Run the bridge: `cd ../whatsapp-bridge && npm install && npm start` (scan QR).
2. (Optional) Run/deploy the summarizer and put its URL in the app's **⚙
   Settings → Summarizer backend URL**. Without it, the app shows the raw
   digest, clearly marked "Not summarized".
3. Click **Refresh**.

## Build a signed app (later)

`npm run build` produces a `.app`/`.dmg`. For Gatekeeper-clean installs, sign
with an Apple Developer ID and notarize (automated; not App Store review). The
placeholder icons in `src-tauri/icons/` should be replaced first.

## Layout

- `src/` — frontend (plain HTML/JS/CSS, no build step; `withGlobalTauri`).
- `src-tauri/` — Rust shell + the `run_pipeline` / `bridge_health` commands.
