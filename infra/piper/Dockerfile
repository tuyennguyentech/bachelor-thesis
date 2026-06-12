FROM python:3.11-slim

RUN apt-get update && apt-get install -y curl libgomp1 libstdc++6 && rm -rf /var/lib/apt/lists/*

# USE_CUDA_RUNTIME=0 → CPU-only (default, uses onnxruntime).
# USE_CUDA_RUNTIME=1 → GPU (uses onnxruntime-gpu; set via compose.gpu.yml build arg).
# piper-tts pulls onnxruntime as a dependency; onnxruntime-gpu replaces it for CUDA.
ARG USE_CUDA_RUNTIME=0
RUN if [ "$USE_CUDA_RUNTIME" = "1" ]; then \
      pip install --no-cache-dir piper-tts fastapi "uvicorn[standard]" onnxruntime-gpu; \
    else \
      pip install --no-cache-dir piper-tts fastapi "uvicorn[standard]"; \
    fi

COPY server.py /app/server.py
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

VOLUME ["/models"]
EXPOSE 5000
ENTRYPOINT ["/entrypoint.sh"]
