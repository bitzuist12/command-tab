#!/usr/bin/env bash
# One command to run WhatsApp summarization FULLY on-device.
# Starts llama.cpp with a small local model, then the summarizer pointed at it.
# Nothing leaves the machine.
#
# Requires: llama.cpp  (brew install llama.cpp)
# Usage:    ./run-on-device.sh        # default Qwen2.5-3B (downloads ~2GB on first run)
#           MODEL_REPO=... ./run-on-device.sh
set -euo pipefail

MODEL_REPO="${MODEL_REPO:-Qwen/Qwen2.5-3B-Instruct-GGUF:Q4_K_M}"
LLAMA_PORT="${LLAMA_PORT:-8080}"

if ! command -v llama-server >/dev/null 2>&1; then
  echo "llama-server not found. Install with: brew install llama.cpp" >&2
  exit 1
fi

echo "▶ Starting llama.cpp with ${MODEL_REPO} on :${LLAMA_PORT} (first run downloads the model)..."
llama-server -hf "${MODEL_REPO}" --port "${LLAMA_PORT}" -c 4096 --jinja &
LLAMA_PID=$!
trap 'kill ${LLAMA_PID} 2>/dev/null || true' EXIT

echo "▶ Waiting for the model to load..."
until curl -s "http://127.0.0.1:${LLAMA_PORT}/health" 2>/dev/null | grep -q '"status":"ok"'; do sleep 2; done
echo "✓ Model ready."

echo "▶ Starting summarizer (on-device, nothing leaves the machine)..."
LLM_BASE_URL="http://127.0.0.1:${LLAMA_PORT}/v1" SUMMARIZER_MODEL="${MODEL_REPO%%:*}" node server.js
