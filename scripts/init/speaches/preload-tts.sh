#!/bin/sh
# preload-tts.sh — pull the Piper TTS models that Speaches serves at
# /v1/audio/speech, so the first synthesis request is not blocked on a cold
# model download.
#
# Run once at `podman compose up` by the `speaches-init` sidecar, which waits
# for the speaches service to become healthy (depends_on: service_healthy).
# This mirrors the Postgres init pattern (scripts/init/postgresql) for a
# third-party image that has no built-in entrypoint hook.
#
# Idempotent: re-pulling an already-downloaded model is a fast no-op. A pull
# failure is logged but non-fatal — the model would simply download on first use.
set -eu

SPEACHES_URL="${SPEACHES_URL:-http://speaches:8000}"

for model in "$TTS_VI_MODEL" "$TTS_EN_MODEL"; do
  [ -n "$model" ] || continue
  echo "preload-tts: pulling $model ..."
  if curl -fsS -X POST "$SPEACHES_URL/v1/models/$model" >/dev/null; then
    echo "preload-tts: ok $model"
  else
    echo "preload-tts: WARN could not pull $model (will download on first use)" >&2
  fi
done

echo "preload-tts: done"
