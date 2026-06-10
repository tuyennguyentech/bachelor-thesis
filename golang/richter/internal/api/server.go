package api

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"

	"example.com/richter/cfg"
	"example.com/richter/internal"
	v1 "example.com/richter/internal/api/v1"
	"example.com/richter/log"
	"github.com/samber/do/v2"
)

var Package = do.Package(
	do.Lazy(NewServerSvc),
)

func init() {
	Package(internal.Injector)
}

type ServerSvc struct {
	srv *http.Server
}

var _ do.ShutdownerWithContextAndError = (*ServerSvc)(nil)

func NewServerSvc(i do.Injector) (s *ServerSvc, err error) {
	apiCfg, err := do.Invoke[*cfg.ApiCfg](i)
	if err != nil {
		return
	}
	v1, err := do.Invoke[*v1.V1Svc](i)
	if err != nil {
		return
	}
	p := new(http.Protocols)
	p.SetHTTP1(true)
	p.SetUnencryptedHTTP2(true)
	srv := &http.Server{
		Addr:      fmt.Sprintf("%s:%d", apiCfg.Host, apiCfg.Port),
		Handler:   v1.Mux,
		Protocols: p,
	}
	// 0 = unlimited (no timeout). Production defaults come from cfg.
	if apiCfg.ReadHeaderTimeout > 0 {
		srv.ReadHeaderTimeout = apiCfg.ReadHeaderTimeout
	}
	if apiCfg.IdleTimeout > 0 {
		srv.IdleTimeout = apiCfg.IdleTimeout
	}
	s = &ServerSvc{srv: srv}
	return
}

func (s *ServerSvc) Start(ctx context.Context) {
	log := log.FromCtx(ctx)
	go func() {
		if err := s.srv.ListenAndServe(); err != nil {
			log.ErrorContext(
				ctx,
				"cannot start server",
				slog.String("addr", s.srv.Addr),
				slog.Any("err", err),
			)
		}
	}()
}

func (s *ServerSvc) Shutdown(ctx context.Context) error {
	// Respect caller's deadline if any, otherwise bound shutdown at the
	// configured ShutdownTimeout so we don't hang forever. 0 = unlimited.
	if _, ok := ctx.Deadline(); !ok {
		apiCfg, cfgErr := do.Invoke[*cfg.ApiCfg](internal.Injector)
		if cfgErr == nil && apiCfg.ShutdownTimeout > 0 {
			var cancel context.CancelFunc
			ctx, cancel = context.WithTimeout(ctx, apiCfg.ShutdownTimeout)
			defer cancel()
		}
	}
	return s.srv.Shutdown(ctx)
}
