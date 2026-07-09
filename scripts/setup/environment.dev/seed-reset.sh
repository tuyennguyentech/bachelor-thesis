#!/usr/bin/env bash
# seed-reset.sh — Rebuild the local stack on the portable ./volumes bind mounts
# and run the full dev seed from scratch.
#
# DESTRUCTIVE & REPRODUCIBLE: stops the stack, wipes ./volumes data dirs, brings
# the stack back up, then runs goose migrations explicitly (migrations are a
# developer step, not a sidecar). FoundationDB is auto-configured by the fdb-init
# sidecar in compose.yml (a fresh/empty FDB dir gets `configure new single ssd` once,
# idempotently), so this script just waits for it. Finally it runs `seed --dev`.
#
# `seed --dev` is fully idempotent and seeds EVERYTHING: the real GPU
# Whisper+Gemini pipeline for the "Tự học Machine Learning" demo course AND the
# dense, diverse student attempts (generated THROUGH the real submit flow
# in-process — there is no separate attempts script). To top up without a full
# rebuild, skip this script and run the `seed --dev` line below against the
# existing stack.
#
# Whisper runs on GPU by default (compose.gpu.yml + /etc/cdi/nvidia.yaml). Set
# GPU=0 for CPU-only (much slower). Set SKIP_SEED=1 to bring up infra only.
set -euo pipefail

cd "$(dirname "$0")/../../.."
ROOT="$PWD"
SHELL_SH="./scripts/setup/environment.dev/container-shell.sh"

GPU="${GPU:-1}"
COMPOSE=(podman compose -f compose.yml)
[ "$GPU" = "1" ] && COMPOSE+=(-f compose.gpu.yml)

# Data dirs wiped on reset. NOTE: hf-cache is intentionally EXCLUDED — the speaches
# model cache is a volumes bind mount too, but keeping it avoids re-downloading
# the Whisper/Piper models on every reset.
VOL_SUBDIRS=(postgres fdb-coordinator fdb-server-1 fdb-server-2 seaweedfs caddy-data caddy-config)

echo "=== [1/4] Stop stack (down -v; DATA lives in ./volumes, wiped next) ==="
# `down -v`: the -v removes the ANONYMOUS volumes podman creates for image-declared
# VOLUME paths that no bind mount covers (e.g. the fdb-init sidecar runs the
# foundationdb image, whose /var/fdb/data VOLUME is unbound there) — a plain `down`
# leaves one dangling per reset cycle, so repeated resets never reproduce a truly
# fresh machine. There are no named volumes, and the REAL data lives in ./volumes
# BIND mounts, which -v never touches. The model cache (volumes/hf-cache) is kept
# (not in VOL_SUBDIRS) so resets don't re-download models.
"${COMPOSE[@]}" down -v --remove-orphans || true

echo "=== [2/4] Wipe ./volumes data dirs ==="
# postgres/fdb data is owned by the container's mapped subuid (the containers
# chown/write it themselves; the compose :U flag is stripped by the docker-compose
# provider), which the host user cannot rm directly — delete inside the rootless
# user namespace.
for d in "${VOL_SUBDIRS[@]}"; do
  podman unshare rm -rf "$ROOT/volumes/$d" 2>/dev/null || rm -rf "$ROOT/volumes/$d"
  mkdir -p "$ROOT/volumes/$d"
done

echo "=== [3/4] Bring stack up (GPU=$GPU) ==="
"${COMPOSE[@]}" up -d
echo -n "  postgres "; until podman exec dyadia-postgres-1 pg_isready -U dyadia -q 2>/dev/null; do echo -n .; sleep 2; done; echo "ready"

# FoundationDB: a freshly-wiped data dir is UNCONFIGURED, but the fdb-init sidecar
# (compose.yml) runs `configure new single ssd` on it automatically. Just wait for
# the cluster to report available (works whether it was fresh or already configured).
echo -n "  fdb: waiting for fdb-init to configure the cluster "
until podman exec dyadia-fdb-coordinator-1 fdbcli --exec "status minimal" 2>/dev/null | grep -qF "The database is available"; do echo -n .; sleep 3; done
echo "ready"

# Migrations are a developer step (no sidecar): run goose explicitly against the dev
# DB now that Postgres is up. Idempotent — skips already-applied migrations.
echo -n "  goose migrate (dev DB) ... "
if ! "$SHELL_SH" richter -- ./scripts/setup/environment.dev/goose.sh dev up; then
  echo "ERROR: goose migration failed" >&2
  exit 1
fi
echo "done"
# The volume wipe above destroyed dyadia_test too (same Postgres instance) — the init
# script recreates it EMPTY. Migrate it now so the integ/E2E suites don't mysteriously
# fail with "admin login: internal error" on a table-less test DB. (Test-DB SEED stays
# a separate explicit step — see CLAUDE.md — this only restores the schema.)
echo -n "  goose migrate (test DB) ... "
if ! "$SHELL_SH" richter -- ./scripts/setup/environment.dev/goose.sh test up; then
  echo "ERROR: goose test-DB migration failed" >&2
  exit 1
fi
echo "done"
echo -n "  speaches "; until [ "$(podman inspect -f '{{.State.Health.Status}}' dyadia-speaches-1 2>/dev/null)" = "healthy" ]; do echo -n .; sleep 3; done; echo "healthy"
echo -n "  speaches model preload "; podman wait dyadia-speaches-init-1 >/dev/null 2>&1 || true; echo "done"

if [ "${SKIP_SEED:-0}" = "1" ]; then
  echo "=== [4/4] SKIP_SEED=1 — infra up + migrated; seed separately with: ==="
  echo "  $SHELL_SH richter -- go run ./golang/richter/ -c golang/richter/richter.base.toml,golang/richter/richter.local.toml seed --dev"
  echo "=== INFRA-RESET COMPLETE (seed skipped) ==="
  exit 0
fi

echo "=== [4/4] Seed dev data (real GPU Whisper + Gemini ML pipeline + dense attempts via flow — long step) ==="
[ -f "$ROOT/.env" ] && set -a && . "$ROOT/.env" && set +a
"$SHELL_SH" richter -- go run ./golang/richter/ \
  -c golang/richter/richter.base.toml,golang/richter/richter.local.toml seed --dev

echo "=== SEED-RESET COMPLETE — stack up + fully seeded. Open http://localhost:8080 ==="
