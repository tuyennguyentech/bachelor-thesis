#!/bin/sh
# dev-shell.sh — Enter Podman rootless netns with compose DNS (one-way)
# See docs/LocalDevEnvironment.md for details.
#
# Usage:
#   ./dev-shell.sh                          # default container, opens sh
#   ./dev-shell.sh -- go run ./...          # default container, run command
#   ./dev-shell.sh mycontainer -- command   # specific container

set -eu

COMPOSE_PROJECT="${COMPOSE_PROJECT:-dyadia}"
DEFAULT_CONTAINER="${COMPOSE_PROJECT}-fdb-coordinator-1"

# --- Parse args: [CONTAINER] [--] [COMMAND...] ---
CONTAINER="${1:-$DEFAULT_CONTAINER}"
if [ "$CONTAINER" = "--" ]; then
  CONTAINER="$DEFAULT_CONTAINER"
fi
if [ $# -gt 0 ]; then shift; fi

# Strip leading "--" if present
if [ "${1:-}" = "--" ]; then
  shift
fi

# Default to sh if no command given
if [ $# -eq 0 ]; then
  set -- sh
fi

# --- Validate ---
NETNS=$(podman inspect "$CONTAINER" --format '{{.NetworkSettings.SandboxKey}}' 2>/dev/null) || {
  echo "Error: container '$CONTAINER' not found" >&2
  exit 1
}
if [ -z "$NETNS" ]; then
  echo "Error: container '$CONTAINER' is not running" >&2
  exit 1
fi

DNS=$(podman network inspect dyadia_default \
  --format '{{range .Subnets}}{{.Gateway}}{{end}}' | head -1)

echo "Entering rootless netns with DNS from $CONTAINER"
echo "  netns : $NETNS"
echo "  dns   : $DNS"

podman unshare --rootless-netns \
  unshare --mount sh -c '
    DNS="$1"; shift
    echo "nameserver $DNS" > /tmp/resolv.conf
    mount --bind /tmp/resolv.conf /etc/resolv.conf
    exec "$@"
  ' -- "$DNS" "$@"
