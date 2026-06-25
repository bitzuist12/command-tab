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

## Run locally (hosted model)

```bash
cd summarizer-backend
cp .env.example .env   # set LLM_API_KEY (OpenRouter)
npm start
curl localhost:8090/health
```

## Run fully on-device (privacy-max, nothing leaves the machine)

The same server can point at a local model — recommended for WhatsApp, since
message text never leaves the laptop.

```bash
# Ollama (OpenAI-compatible on :11434)
ollama pull qwen2.5:3b
LLM_BASE_URL=http://127.0.0.1:11434/v1 SUMMARIZER_MODEL=qwen2.5:3b npm start
```

```bash
# llama.cpp (OpenAI-compatible on :8080)
llama-server -m qwen2.5-3b-instruct-q4_k_m.gguf --port 8080
LLM_BASE_URL=http://127.0.0.1:8080/v1 SUMMARIZER_MODEL=qwen2.5-3b npm start
```

In the desktop app, this whole service eventually ships **inside** the app as a
bundled llama.cpp sidecar, so a normal user just runs the app — no key, no
cloud, no setup.

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
