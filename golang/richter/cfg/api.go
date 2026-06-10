package cfg

import (
	"fmt"
	"time"

	"github.com/samber/do/v2"
)

type ApiCfg struct {
	Host string `mapstructure:"host"`
	Port uint16 `mapstructure:"port"`
	// ReadHeaderTimeout caps the time the server will wait for request
	// headers. 0 = unlimited (slow-loris attack vector).
	ReadHeaderTimeout time.Duration `mapstructure:"read_header_timeout"`
	// IdleTimeout caps keep-alive idle connections. 0 = unlimited.
	IdleTimeout time.Duration `mapstructure:"idle_timeout"`
	// ShutdownTimeout is the default bound on a graceful shutdown
	// (used by the server's Shutdown method when the caller's context
	// has no deadline). 0 = unlimited.
	ShutdownTimeout time.Duration `mapstructure:"shutdown_timeout"`
}

func NewApiCfgSvc(i do.Injector) (l *ApiCfg, err error) {
	r, err := do.Invoke[*RichterCfg](i)
	if err != nil {
		err = fmt.Errorf("RichterCfg cannot be invoked: %w", err)
		return
	}
	l = &r.ApiCfg
	return
}

func NewApiCfg() ApiCfg {
	return ApiCfg{
		Host:              "localhost",
		Port:              8080,
		ReadHeaderTimeout: 30 * time.Second,
		IdleTimeout:       120 * time.Second,
		ShutdownTimeout:   30 * time.Second,
	}
}
