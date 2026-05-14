#!/bin/sh

BASE_CONF=$(realpath ./golang/richter/richter.base.toml)
TEST_CONF=$(realpath ./golang/richter/richter.test.toml)
FDB_CLUSTER=$(realpath ./fdb.cluster)

# $@ = -tags=integ,unit -v ...

RICHTER_FDB_CLUSTER_FILE="$FDB_CLUSTER" \
go test ./golang/richter/... "$@" \
  -args -config "$BASE_CONF,$TEST_CONF"
