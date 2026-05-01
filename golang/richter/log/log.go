package log

import (
	"context"
	"fmt"
	"log/slog"
	"os"

	"example.com/richter/cfg"
	"example.com/richter/internal"
	"github.com/samber/do/v2"
)

var Injector = internal.Injector.Scope("log")

var Package = do.Package(
	do.Lazy(NewLogSvc),
)

type LogSvc struct {
	slog.Logger
	slog.LevelVar
}

func NewLogSvc(i do.Injector) (logSvc *LogSvc, err error) {
	logCfg, err := do.Invoke[*cfg.LogCfg](i)
	if err != nil {
		err = fmt.Errorf("LogCfg cannot be invoked: %w", err)
		return
	}
	logSvc = new(LogSvc)
	err = logSvc.UnmarshalText([]byte(logCfg.Level))
	if err != nil {
		err = fmt.Errorf("Cannot unmarshal log level from %q: %w", logCfg.Level, err)
		return
	}
	logSvc.Logger = *slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{
		AddSource: logSvc.Level() == slog.LevelDebug,
		Level:     &logSvc.LevelVar,
	}))
	return
}

type ctxKey struct{}

var logSvcKey = ctxKey{}

var base *LogSvc

func WithLogger(ctx context.Context, l *LogSvc) context.Context {
	return context.WithValue(ctx, logSvcKey, l)
}

func FromCtx(ctx context.Context) *LogSvc {
	if l, ok := ctx.Value(logSvcKey).(*LogSvc); ok {
		return l
	}
	return base
}

func init() {
	Package(internal.Injector)
	base = &LogSvc{
		Logger: *slog.Default(),
	}
}
