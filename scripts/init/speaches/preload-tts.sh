#!/bin/sh
# preload-tts.sh — pull the models Speaches serves so the first request is not
# blocked on a cold download:
#   - the Whisper STT model used at /v1/audio/transcriptions (STT_MODEL)
#   - the Piper TTS models served at /v1/audio/speech (TTS_VI_MODEL/TTS_EN_MODEL)
#
# The STT model is CRITICAL: Speaches' PRELOAD_MODELS only loads an
# ALREADY-DOWNLOADED model into memory — it does NOT fetch it. After a model-cache
# wipe (`.volumes/hf-cache`), the model is absent and /v1/audio/transcriptions returns
# 404 "Model '<name>' is not installed locally" with no auto-download. So we must
# explicitly POST /v1/models/<name> here, exactly like the TTS models.
#
# Run once at compose up by the `speaches-init` sidecar (depends_on:
# service_healthy). Mirrors the Postgres init pattern for a third-party image
# with no entrypoint hook.
#
# Idempotent: re-pulling an already-downloaded model is a fast no-op. A pull
# failure is logged but non-fatal — the model would download on first use.
set -eu

SPEACHES_URL="${SPEACHES_URL:-http://speaches:8000}"

for model in "${STT_MODEL:-}" "$TTS_VI_MODEL" "$TTS_EN_MODEL"; do
  [ -n "$model" ] || continue
  echo "preload-models: pulling $model ..."
  if curl -fsS -X POST "$SPEACHES_URL/v1/models/$model" >/dev/null; then
    echo "preload-models: ok $model"
  else
    echo "preload-models: WARN could not pull $model (will download on first use)" >&2
  fi
done

echo "preload-models: done"
