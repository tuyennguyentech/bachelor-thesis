 #!/bin/sh

BASE_CONF=$(realpath ./golang/richter/richter.base.toml)
TEST_CONF=$(realpath ./golang/richter/richter.test.toml)

# $@ = -tags=integ,unit -v ...

go test ./golang/richter/... "$@" \
  -args -config "$BASE_CONF,$TEST_CONF"
