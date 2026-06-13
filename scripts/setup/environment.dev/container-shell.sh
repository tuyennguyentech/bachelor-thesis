#!/bin/sh
# container-shell.sh — Run host process inside compose network namespace
# See docs/ContainerShell.md for details.
#
# Usage:
#   ./container-shell.sh                          # default container, opens sh
#   ./container-shell.sh -- go run ./...          # default container, run command
#   ./container-shell.sh richter -- command        # specific service

set -eu

COMPOSE_PROJECT="${COMPOSE_PROJECT:-dyadia}"
DEFAULT_CONTAINER="debug"

# Load the repo .env so app-level env (RICHTER_AI_*, RICHTER_STT_*, RICHTER_TTS_*, WHISPER__*) reaches
# the exec'd process. container-shell only joins the container's NETWORK namespace
# (nsenter -n) — it does NOT inherit the container's environment — so concurrency
# config kept in .env must be sourced here for the host go-run process to see it.
_REPO_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)"
if [ -f "$_REPO_ROOT/.env" ]; then
  set -a
  . "$_REPO_ROOT/.env"
  set +a
fi

# --- Parse args: [CONTAINER] [--] [COMMAND...] ---
CONTAINER="${1:-$DEFAULT_CONTAINER}"
if [ "$CONTAINER" = "--" ]; then
  CONTAINER="$DEFAULT_CONTAINER"
fi

CONTAINER="${COMPOSE_PROJECT}-${CONTAINER}-1"

if [ $# -gt 0 ]; then shift; fi

# Strip leading "--" if present
if [ "${1:-}" = "--" ]; then
  shift
fi

# Default to bash if no command given
if [ $# -eq 0 ]; then
  set -- sh
fi

# --- Validate ---
PID=$(podman inspect "$CONTAINER" --format '{{.State.Pid}}' 2>/dev/null) || {
  echo "Error: container '$CONTAINER' not found" >&2
  exit 1
}
if [ -z "$PID" ] || [ "$PID" = "0" ]; then
  echo "Error: container '$CONTAINER' is not running" >&2
  exit 1
fi

# --- Detect network and IP ---
RAW_NETWORK=$(podman inspect "$CONTAINER" \
  --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}')
NETWORK=$(echo "$RAW_NETWORK" | awk '{print $1}')

DEV_IP=$(podman inspect "$CONTAINER" \
  --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}')

echo "Entering namespace of $CONTAINER ($DEV_IP on $NETWORK)"

# Layer 1: podman unshare    — rootless user ns (see container PIDs)
# Layer 2: nsenter -t -n     — container network ns (get IP on bridge)
# Layer 3: unshare --mount   — private mount ns (override resolv.conf safely)
# podman unshare --rootless-netns nsenter -t "$PID" -n unshare --mount sh -c "
podman unshare nsenter -t "$PID" -n unshare --mount sh -c "
set -eu
if [ -f /proc/$PID/root/etc/resolv.conf ]; then
  cp /proc/$PID/root/etc/resolv.conf /tmp/dev-resolv.conf
else
  : > /tmp/dev-resolv.conf
fi
mount --bind /tmp/dev-resolv.conf /etc/resolv.conf
if [ -f /proc/$PID/root/etc/nsswitch.conf ]; then
  cp /proc/$PID/root/etc/nsswitch.conf /tmp/dev-nsswitch.conf
else
  : > /tmp/dev-nsswitch.conf
fi
mount --bind /tmp/dev-nsswitch.conf /etc/nsswitch.conf
exec \"\$@\"
" -- "$@"
