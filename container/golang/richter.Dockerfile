# syntax=docker/dockerfile:1
#
# richter — Go backend. Multi-stage:
#   build:  latest Go (Debian/glibc, CGO) + FoundationDB C client + buf + sqlc.
#           Runs codegen (buf generate + sqlc generate) because a fresh checkout
#           ships NO generated code, then builds the binary.
#   runtime: distroless/cc (glibc — required by the FoundationDB C client).
#
# Build context is the REPO ROOT (see compose.dev.yml). Only the inputs needed to
# build are copied; .dockerignore keeps gen/, node_modules/, volumes/ etc. out.

# Version pins — SINGLE SOURCE is .env (DYADIA_*/FDB_VERSION), passed as build args by
# compose.build.yml. No defaults here so nothing is hardcoded/duplicated; build via
# `podman compose -f compose.yml -f compose.build.yml build`.
ARG GO_VERSION
ARG FDB_VERSION
ARG BUF_VERSION
ARG SQLC_VERSION
ARG FFMPEG_VERSION

# ffmpeg — richter shells out to it at RUNTIME to extract/segment a video's audio
# (16 kHz mono PCM) before transcription (see internal/svc/ai/media_transcription.go).
# distroless ships no package manager, so we pull a fully STATIC ffmpeg (zero shared-
# lib deps → runs as-is on distroless) and copy just the binary into the final image.
# FFmpeg publishes no official container image; mwader/static-ffmpeg is the de-facto
# standard, version-pinned static build. Only `ffmpeg` is needed — richter avoids
# `ffprobe` by design (chunk durations are derived arithmetically, not probed).
FROM mwader/static-ffmpeg:${FFMPEG_VERSION} AS ffmpeg

FROM golang:${GO_VERSION}-bookworm AS build
ARG FDB_VERSION
ARG BUF_VERSION
ARG SQLC_VERSION

# FoundationDB C client (libfdb_c.so + headers fdb_c.h) — required to compile the
# Go FDB bindings (CGO). Official .deb from the FoundationDB GitHub release.
ADD https://github.com/apple/foundationdb/releases/download/${FDB_VERSION}/foundationdb-clients_${FDB_VERSION}-1_amd64.deb /tmp/fdb-clients.deb
RUN dpkg -i /tmp/fdb-clients.deb && rm /tmp/fdb-clients.deb

# buf CLI — official versioned binary release (https://buf.build/docs/cli/installation).
# sqlc — official versioned binary release (https://docs.sqlc.dev).
RUN curl -fsSL "https://github.com/bufbuild/buf/releases/download/v${BUF_VERSION}/buf-$(uname -s)-$(uname -m)" \
      -o /usr/local/bin/buf && chmod +x /usr/local/bin/buf \
 && curl -fsSL "https://downloads.sqlc.dev/sqlc_${SQLC_VERSION}_linux_amd64.tar.gz" \
      | tar -xz -C /usr/local/bin sqlc

WORKDIR /src

# 1) Code generation. A fresh checkout has no generated code:
#    buf generate (remote plugins → needs network) → golang/buf/gen
#    sqlc generate → golang/sql/gen
COPY buf.yaml buf.gen.yaml buf.lock sqlc.yaml ./
COPY proto/ ./proto/
COPY sql/ ./sql/
COPY golang/buf/ ./golang/buf/
COPY golang/sql/ ./golang/sql/
COPY golang/richter/ ./golang/richter/
RUN buf generate && sqlc generate

# 2) Build the binary. richter's go.mod carries the replace directives
#    (../buf, ../sql), so GOWORK=off builds it standalone — no workspace, no arthur.
#    CGO links libfdb_c (installed above).
ENV CGO_ENABLED=1 GOWORK=off
# -trimpath + -ldflags "-s -w" strip paths + debug/symbol tables → smaller binary.
RUN go build -C golang/richter -trimpath -ldflags="-s -w" -o /out/richter .

# ── runtime ──────────────────────────────────────────────────────────────────
# distroless/cc carries glibc (+ libssl, libstdc++) for the CGO binary. We add
# libfdb_c.so and the two libs it needs that cc does not ship (liblzma, libz).
FROM gcr.io/distroless/cc-debian12:nonroot AS richter
COPY --from=build /usr/lib/libfdb_c.so /usr/lib/libfdb_c.so
COPY --from=build /usr/lib/x86_64-linux-gnu/liblzma.so.5 /usr/lib/x86_64-linux-gnu/liblzma.so.5
COPY --from=build /usr/lib/x86_64-linux-gnu/libz.so.1 /usr/lib/x86_64-linux-gnu/libz.so.1
# Static ffmpeg (see the ffmpeg build stage above) → on PATH for the transcription step.
COPY --from=ffmpeg /ffmpeg /usr/local/bin/ffmpeg
COPY --from=build /out/richter /usr/local/bin/richter
# WORKDIR / — the distroless :nonroot base defaults WORKDIR to /home/nonroot, but
# richter.base.toml sets [fdb] cluster_file = "fdb.cluster" (a RELATIVE path, so the
# same config works from the repo root in the host dev loop). The FDB C client
# resolves that relative path against the process CWD, so the CWD must be where the
# cluster file is mounted (compose.dev.yml mounts it at /fdb.cluster). Without this,
# OpenDatabase looks in /home/nonroot, fails, and every FDB op (e.g. persisting a
# freshly transcribed lesson to FDB) errors 1515 "No cluster file found".
WORKDIR /
EXPOSE 8080
ENTRYPOINT ["richter"]
# Config is MOUNTED at runtime (compose.dev.yml) — never baked into the image.
CMD ["-c", "/etc/richter/richter.base.toml,/etc/richter/richter.local.toml"]
