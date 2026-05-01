//go:build integ

package db

import (
	"context"
	"testing"

	"example.com/richter/internal"
	"github.com/samber/do/v2"
)

func setupPostgresSvc(t *testing.T) (p *PostgresSvc) {
	t.Helper()
	p = do.MustInvoke[*PostgresSvc](internal.Injector)
	t.Cleanup(func() {
		_ = do.Shutdown[*PostgresSvc](internal.Injector)
	})
	return
}

func TestPing(t *testing.T) {
	p := setupPostgresSvc(t)
	if err := p.Ping(context.Background()); err != nil {
		t.Fatal(err)
	}
}
