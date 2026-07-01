# Migration init image: a goose binary + the project migrations, run once at
# `compose up` to bring the database schema up to date. Idempotent — goose skips
# already-applied migrations, so it is a no-op on a database whose data dir was
# copied in for a portable run. Build context is the repo root (see .dockerignore).
# Versions come from compose build args (single source: .env), like the app images.
ARG GO_VERSION=1.26
ARG GOOSE_VERSION=3.27.1
FROM golang:${GO_VERSION}-alpine AS build
ARG GOOSE_VERSION
RUN go install github.com/pressly/goose/v3/cmd/goose@v${GOOSE_VERSION}

FROM alpine:3.21
COPY --from=build /go/bin/goose /usr/local/bin/goose
COPY sql/migrations /migrations
# ENTRYPOINT fixes driver + dir; the compose `command` supplies the DB string + verb.
ENTRYPOINT ["goose", "-dir", "/migrations", "postgres"]
