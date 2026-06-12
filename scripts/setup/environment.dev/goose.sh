#!/bin/sh
# goose.sh — Run goose with layered env (inheritance: base + per-env overlay).
#
# Usage (always inside container-shell so `postgres` DNS resolves):
#   ./scripts/setup/environment.dev/container-shell.sh richter -- \
#       ./scripts/setup/environment.dev/goose.sh <dev|test> <goose args...>
#
# Examples:
#   goose.sh test up
#   goose.sh test reset
#   goose.sh dev status
#
# Layering (later wins; `set -a` force-exports so these always beat any stray
# GOOSE_* leaked into the environment by container-shell sourcing .env):
#   1. .env.goose      shared: GOOSE_DRIVER + GOOSE_MIGRATION_DIR
#   2. .env.<target>   overlay: GOOSE_DBSTRING for that DB (dev → dyadia, test → dyadia_test)
set -eu

_REPO_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)"

if [ $# -lt 1 ]; then
  echo "Usage: goose.sh <dev|test> <goose args...>" >&2
  exit 2
fi

TARGET="$1"
shift

case "$TARGET" in
  dev|test) ;;
  *)
    echo "Error: target must be 'dev' or 'test', got '$TARGET'" >&2
    exit 2
    ;;
esac

BASE="$_REPO_ROOT/.env.goose"
OVERLAY="$_REPO_ROOT/.env.$TARGET"

# Missing config MUST fail — never silently fall through to a wrong/default DB.
for f in "$BASE" "$OVERLAY"; do
  if [ ! -f "$f" ]; then
    echo "Error: required env file not found: $f" >&2
    exit 1
  fi
done

set -a
. "$BASE"
. "$OVERLAY"
set +a

# goose runs relative to the repo root (GOOSE_MIGRATION_DIR is ./sql/migrations).
cd "$_REPO_ROOT"
exec goose "$@"
