 #!/bin/sh

BASE_CONF=$(realpath ./golang/richter/richter.base.toml)
TEST_CONF=$(realpath ./golang/richter/richter.test.toml)

# $@ = -tags=integ ...

go test ./golang/richter/... "$@" -v \
  -args -config "$BASE_CONF,$TEST_CONF"
