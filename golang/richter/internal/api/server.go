package api

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"time"

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
	s = &ServerSvc{
		srv: &http.Server{
			Addr:              fmt.Sprintf("%s:%d", apiCfg.Host, apiCfg.Port),
			Handler:           v1.Mux,
			Protocols:         p,
			ReadHeaderTimeout: 30 * time.Second,
			IdleTimeout:       120 * time.Second,
		},
	}
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

func (s *ServerSvc) Shutdown(_ context.Context) error {
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	return s.srv.Shutdown(shutdownCtx)
}
