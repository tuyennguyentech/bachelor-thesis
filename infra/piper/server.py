import asyncio
import io
import os
import threading
import wave

from fastapi import FastAPI, Query, Response
from fastapi.responses import PlainTextResponse
from starlette.concurrency import run_in_threadpool
from piper.voice import PiperVoice

app = FastAPI()

MODELS_DIR = os.environ.get("PIPER_MODELS_DIR", "/models")
# Set PIPER_USE_CUDA=1 (via compose.gpu.yml + USE_CUDA_RUNTIME build arg) to enable GPU
# inference.  Requires onnxruntime-gpu to be installed in the image.
USE_CUDA = os.environ.get("PIPER_USE_CUDA", "0") == "1"

# PIPER_NUM_WORKERS bounds how many TTS syntheses run concurrently.
# 0 = unlimited. Set in .env and wired via compose so it stays in sync with the
# richter-side cap (RICHTER_AI_PIPER_MAX_CONCURRENT). On CPU, ~num-cores is a
# sensible value; on GPU it can usually be higher.
NUM_WORKERS = int(os.environ.get("PIPER_NUM_WORKERS", "0"))
_synth_sem: asyncio.Semaphore | None = asyncio.Semaphore(NUM_WORKERS) if NUM_WORKERS > 0 else None

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


def _synthesize(lang: str, text: str) -> bytes:
    """Blocking synthesis — runs in threadpool to avoid blocking the event loop."""
    voice = _voice(lang)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        voice.synthesize_wav(text, wf)
    buf.seek(0)
    return buf.read()


@app.get("/health")
async def health():
    for v in VOICES.values():
        if not os.path.exists(os.path.join(MODELS_DIR, v + ".onnx")):
            return PlainTextResponse("models not ready", status_code=503)
    return PlainTextResponse("ok")


@app.post("/tts")
async def tts(
    text: str = Query(default=""),
    language: str = Query(default="vi"),
):
    text = text.strip()
    if not text:
        return PlainTextResponse("empty text", status_code=400)
    try:
        if _synth_sem is not None:
            async with _synth_sem:
                wav_bytes = await run_in_threadpool(_synthesize, language, text)
        else:
            wav_bytes = await run_in_threadpool(_synthesize, language, text)
        return Response(content=wav_bytes, media_type="audio/wav")
    except Exception as exc:
        return PlainTextResponse(f"synthesis error: {exc}", status_code=500)
