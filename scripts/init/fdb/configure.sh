#!/bin/bash
# fdb-init: make the FDB cluster configured WITHOUT a manual root step (config-driven).
# Idempotent: if the DB is already available it exits 0 and changes NOTHING (never wipes
# a configured cluster). On a brand-new/empty data dir it runs `configure new single ssd`.
# Runs as a one-shot compose sidecar after the coordinator starts (mirrors migrate/speaches-init).
set -u
CF="${FDB_CLUSTER_FILE:-/var/fdb/fdb.cluster}"
# Fixed cluster id `docker:docker` + coordinator DNS — matches the app's committed fdb.cluster.
echo "docker:docker@${FDB_COORDINATOR:-fdb-coordinator}:${FDB_COORDINATOR_PORT:-4500}" > "$CF"

available() { fdbcli -C "$CF" --exec "status minimal" --timeout 4 2>&1 | grep -q "The database is available"; }

for i in $(seq 1 40); do
  if available; then echo "fdb-init: database already available — nothing to do"; exit 0; fi
  echo "fdb-init: not available (attempt $i) — trying: configure new single ssd"
  fdbcli -C "$CF" --exec "configure new single ssd" --timeout 15 2>&1 | sed 's/^/fdb-init:   /'
  if available; then echo "fdb-init: configured OK"; exit 0; fi
  sleep 2
done
echo "fdb-init: FAILED to reach 'available' state" >&2
exit 1
