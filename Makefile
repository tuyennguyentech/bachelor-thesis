.PHONY: generate-protoc

generate-protoc:
	@test -f golang/buf/go.mod || (mkdir -p golang/buf && cd golang/buf && go mod init example.com/buf)
	buf generate
	cd golang/buf && go mod tidy