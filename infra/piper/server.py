import io
import os
import threading
import wave

from flask import Flask, Response, request
from piper.voice import PiperVoice

app = Flask(__name__)

MODELS_DIR = os.environ.get("PIPER_MODELS_DIR", "/models")
# Set PIPER_USE_CUDA=1 (via compose.gpu.yml + USE_CUDA_RUNTIME build arg) to enable GPU
# inference.  Requires onnxruntime-gpu to be installed in the image.
USE_CUDA = os.environ.get("PIPER_USE_CUDA", "0") == "1"

VOICES = {
    "vi": "vi_VN-vais1000-medium",
    "en": "en_US-lessac-medium",
}

_cache: dict[str, PiperVoice] = {}
_lock = threading.Lock()


def _voice(lang: str) -> PiperVoice:
    with _lock:
        if lang not in _cache:
            name = VOICES.get(lang, VOICES["vi"])
            _cache[lang] = PiperVoice.load(
                os.path.join(MODELS_DIR, name + ".onnx"), use_cuda=USE_CUDA
            )
    return _cache[lang]


@app.get("/health")
def health():
    for v in VOICES.values():
        if not os.path.exists(os.path.join(MODELS_DIR, v + ".onnx")):
            return "models not ready", 503
    return "ok"


@app.post("/tts")
def tts():
    text = request.args.get("text", "").strip()
    lang = request.args.get("language", "vi")
    if not text:
        return "empty text", 400
    try:
        buf = io.BytesIO()
        with wave.open(buf, "wb") as wf:
            _voice(lang).synthesize_wav(text, wf)
        buf.seek(0)
        return Response(buf.read(), mimetype="audio/wav")
    except Exception as exc:
        return f"synthesis error: {exc}", 500


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000)
