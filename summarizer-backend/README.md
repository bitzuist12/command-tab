# Command Tab — Summarizer Backend

Stateless WhatsApp summarizer for the Command Tab desktop app. The local app
sends a digest of recent 1:1 messages; this service summarizes each thread with
a cheap model via **OpenRouter** (`gpt-oss-120b`) and returns structured tags.
It is **no-retention**: message text is summarized and dropped — nothing is
stored.

## API

```text
GET  /health
POST /summarize     Authorization: Bearer <SUMMARIZER_TOKEN>   (if configured)
```

Request body (from the bridge `/digest`):

```json
{ "chats": [ { "id": "…", "name": "Hanh", "unread": 3,
  "messages": [ { "fromMe": false, "from": "Hanh", "body": "…" } ] } ] }
```

Response — each chat gains a `summary` and `structured` block (action label,
pending-from-you vs pending-from-them, topics, suggestion, confidence). A chat
whose summary fails comes back with `summary: null` + `summary_error` (never a
fake summary).

## Run locally

```bash
cd summarizer-backend
cp .env.example .env   # set OPENROUTER_API_KEY
npm start
curl localhost:8090/health
```

## Deploy to Railway

1. Push this folder to a repo (or `railway up` from here).
2. Railway auto-detects Node and runs `npm start`.
3. Set env vars in the Railway dashboard:
   - `OPENROUTER_API_KEY` (required)
   - `SUMMARIZER_TOKEN` (recommended — the app sends it as a Bearer token)
   - `SUMMARIZER_MODEL` (optional, default `openai/gpt-oss-120b`)
4. Point the desktop app's **Summarizer backend URL** at the Railway URL.

## Notes

- **No storage.** Add nothing that persists message text.
- **Cost/abuse:** keep `SUMMARIZER_TOKEN` set, and summarize incrementally
  (only chats with new activity) once wired end-to-end.
- The model is swappable via `SUMMARIZER_MODEL` (any OpenRouter slug).
