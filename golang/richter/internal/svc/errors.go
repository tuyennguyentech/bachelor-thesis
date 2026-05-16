package svc

import (
	"errors"

	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func ConnectDBError(err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return connect.NewError(connect.CodeNotFound, errors.New("not found"))
	}

	if pgErr, ok := errors.AsType[*pgconn.PgError](err); ok {
		switch pgErr.Code {
		case "23505":
			return connect.NewError(connect.CodeAlreadyExists, errors.New("already exists"))
		case "23503":
			return connect.NewError(connect.CodeFailedPrecondition, errors.New("constraint violation"))
		}
	}

	return connect.NewError(connect.CodeInternal, errors.New("internal error"))
}
