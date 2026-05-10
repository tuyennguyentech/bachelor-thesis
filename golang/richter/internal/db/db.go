package db

import (
	"context"
	"fmt"
	"net"
	"net/url"
	"strconv"

	"example.com/richter/cfg"
	"example.com/richter/internal"
	"example.com/sql/gen"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/samber/do/v2"
)

var Injector = internal.Injector.Scope("db")

var Package = do.Package(
	do.Lazy(NewPostgresSvc),
)

func init() {
	Package(internal.Injector)
}

type PostgresSvc struct {
	*pgxpool.Pool
}

var _ do.Shutdowner = (*PostgresSvc)(nil)

func NewPostgresSvc(i do.Injector) (p *PostgresSvc, err error) {
	p = new(PostgresSvc)
	postgreCfg, err := do.Invoke[*cfg.PostgresCfg](i)
	if err != nil {
		return nil, fmt.Errorf("PostgreCfg cannot be invoked: %w", err)
	}
	url := &url.URL{
		Scheme: "postgres",
		User:   url.UserPassword(postgreCfg.User, postgreCfg.Password),
		Host:   net.JoinHostPort(postgreCfg.Host, strconv.FormatUint(uint64(postgreCfg.Port), 10)),
		Path:   postgreCfg.Database,
	}
	config, err := pgxpool.ParseConfig(url.String())
	if err != nil {
		return nil, fmt.Errorf("parse config error: %w", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), postgreCfg.ConnectTimeout)
	defer cancel()

	p.Pool, err = pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		return nil, fmt.Errorf("Cannot create postgres pool: %w", err)
	}
	if err = p.Ping(ctx); err != nil {
		return nil, fmt.Errorf("Cannot ping after create postgres pool: %w", err)
	}
	return
}

func (pool *PostgresSvc) Shutdown() {
	pool.Close()
}

func WithConnection[O any](
	pool *PostgresSvc,
	ctx context.Context,
	f func(*gen.Queries, *pgxpool.Conn) (O, error),
) (out O, err error) {
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return
	}
	defer conn.Release()
	if out, err = f(gen.New(conn), conn); err != nil {
		return
	}
	return
}

func WithConnectionExec(
	pool *PostgresSvc,
	ctx context.Context,
	f func(*gen.Queries, *pgxpool.Conn) error,
) (err error) {
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return
	}
	defer conn.Release()
	if err = f(gen.New(conn), conn); err != nil {
		return
	}
	return
}

func WithCommitTx[O any](
	pool *PostgresSvc,
	ctx context.Context,
	f func(*gen.Queries, pgx.Tx) (O, error),
) (out O, err error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return
	}
	defer tx.Rollback(ctx)
	if out, err = f(gen.New(tx), tx); err != nil {
		return
	}
	return out, tx.Commit(ctx)
}

func WithCommitTxExec(
	pool *PostgresSvc,
	ctx context.Context,
	f func(*gen.Queries, pgx.Tx) error,
) (err error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return
	}
	defer tx.Rollback(ctx)
	if err = f(gen.New(tx), tx); err != nil {
		return
	}
	return tx.Commit(ctx)
}

func WithRollbackTx[O any](
	pool *PostgresSvc,
	ctx context.Context,
	f func(*gen.Queries, pgx.Tx) (O, error),
) (out O, err error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return
	}
	defer tx.Rollback(ctx)
	if out, err = f(gen.New(tx), tx); err != nil {
		return
	}
	return
}

func WithRollbackTxExec(
	pool *PostgresSvc,
	ctx context.Context,
	f func(*gen.Queries, pgx.Tx) error,
) (err error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return
	}
	defer tx.Rollback(ctx)
	if err = f(gen.New(tx), tx); err != nil {
		return
	}
	return
}
