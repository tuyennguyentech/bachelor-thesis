FROM python:3.11-slim

RUN apt-get update && apt-get install -y curl libgomp1 libstdc++6 && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir piper-tts flask

COPY server.py /app/server.py
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

VOLUME ["/models"]
EXPOSE 5000
ENTRYPOINT ["/entrypoint.sh"]
