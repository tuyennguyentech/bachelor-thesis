#!/bin/sh
set -e

MODELS_DIR="${PIPER_MODELS_DIR:-/models}"
mkdir -p "$MODELS_DIR"

HF="https://huggingface.co/rhasspy/piper-voices/resolve/main"

dl() {
    name="$1"
    path="$2"
    onnx="$MODELS_DIR/$name.onnx"
    [ -f "$onnx" ] && return
    echo "piper: downloading $name (this may take a few minutes)..."
    curl -fsSL --connect-timeout 30 --max-time 600 -o "$onnx" "$HF/$path.onnx"
    curl -fsSL --connect-timeout 30 --max-time 60  -o "$onnx.json" "$HF/$path.onnx.json"
    echo "piper: $name ready"
}

dl vi_VN-vais1000-medium vi/vi_VN/vais1000/medium/vi_VN-vais1000-medium
dl en_US-lessac-medium en/en_US/lessac/medium/en_US-lessac-medium

exec uvicorn server:app --host 0.0.0.0 --port 5000 --app-dir /app
