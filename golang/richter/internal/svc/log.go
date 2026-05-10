package svc

import (
	"log/slog"

	"connectrpc.com/connect"
)

func LogAttrs(operation string, err error, attrs ...slog.Attr) []any {
	result := []any{
		slog.String("operation", operation),
		slog.String("code", connect.CodeOf(err).String()),
		slog.Any("error", err),
	}
	for _, attr := range attrs {
		result = append(result, attr)
	}
	return result
}
