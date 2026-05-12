package auth

import (
	"context"
	"fmt"
	"net/http"

	"errors"

	"connectrpc.com/connect"
	"connectrpc.com/validate"
	jwtv1 "example.com/buf/gen/richter/jwt/v1"
	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/buf/gen/richter/v1/richterv1connect"
	"example.com/richter/cfg"
	"example.com/richter/internal"
	"example.com/richter/internal/db"
	"example.com/richter/internal/secure"
	"example.com/richter/internal/svc"
	"example.com/richter/internal/svc/users"
	"example.com/richter/log"
	"example.com/sql/gen"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/samber/do/v2"
)

var Package = do.Package(
	do.Lazy(NewAuthSvc),
)

func init() {
	Package(internal.Injector)
}

type AuthSvc struct {
	pg   *db.PostgresSvc
	log  *log.LogSvc
	jwt  *secure.JWTService
	auth *cfg.AuthCfg
}

var _ richterv1connect.AuthServiceHandler = (*AuthSvc)(nil)

func NewAuthSvc(i do.Injector) (a *AuthSvc, err error) {
	a = new(AuthSvc)
	a.pg, err = do.Invoke[*db.PostgresSvc](i)
	if err != nil {
		return nil, fmt.Errorf("PostgresSvc cannot be invoked: %w", err)
	}
	a.log, err = do.Invoke[*log.LogSvc](i)
	if err != nil {
		return nil, fmt.Errorf("LogSvc cannot be invoked: %w", err)
	}
	a.jwt, err = do.Invoke[*secure.JWTService](i)
	if err != nil {
		return nil, fmt.Errorf("JWTService cannot be invoked: %w", err)
	}
	a.auth, err = do.Invoke[*cfg.AuthCfg](i)
	if err != nil {
		return nil, fmt.Errorf("AuthCfg cannot be invoked: %w", err)
	}
	return
}

func (a *AuthSvc) Handler() (string, http.Handler) {
	return richterv1connect.NewAuthServiceHandler(
		a,
		connect.WithInterceptors(validate.NewInterceptor()),
	)
}


func (a *AuthSvc) Login(
	ctx context.Context,
	req *richterv1.LoginRequest,
) (*richterv1.LoginResponse, error) {
	user, err := db.WithConnection(a.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.User, error) {
		return q.GetUserByEmail(ctx, req.GetEmail())
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, connect.NewError(connect.CodeUnauthenticated, fmt.Errorf("invalid credentials"))
		}
		a.log.ErrorContext(ctx, "auth service failed", svc.LogAttrs("Login.GetUserByEmail", err)...)
		return nil, svc.ConnectDBError(err)
	}

	if !secure.VerifyPassword(req.GetPassword(), user.PasswordHash) {
		err = connect.NewError(connect.CodeUnauthenticated, fmt.Errorf("invalid credentials"))
		a.log.ErrorContext(ctx, "auth service failed", svc.LogAttrs("Login.VerifyPassword", err)...)
		return nil, err
	}

	if user.Status != gen.UserStatusActive {
		err = connect.NewError(connect.CodePermissionDenied, fmt.Errorf("account is not active"))
		a.log.ErrorContext(ctx, "auth service failed", svc.LogAttrs("Login.CheckStatus", err)...)
		return nil, err
	}

	protoUser := users.UserToProto(user)

	accessToken, err := a.jwt.GenerateToken(protoUser, a.auth.AccessTokenDuration, jwtv1.TokenType_TOKEN_TYPE_ACCESS)
	if err != nil {
		err = connect.NewError(connect.CodeInternal, err)
		a.log.ErrorContext(ctx, "auth service failed", svc.LogAttrs("Login.GenerateAccessToken", err)...)
		return nil, err
	}

	refreshToken, err := a.jwt.GenerateToken(protoUser, a.auth.RefreshTokenDuration, jwtv1.TokenType_TOKEN_TYPE_REFRESH)
	if err != nil {
		err = connect.NewError(connect.CodeInternal, err)
		a.log.ErrorContext(ctx, "auth service failed", svc.LogAttrs("Login.GenerateRefreshToken", err)...)
		return nil, err
	}

	return &richterv1.LoginResponse{
		AccessToken:  accessToken,
		RefreshToken: refreshToken,
		ExpiresIn:    int64(a.auth.AccessTokenDuration.Seconds()),
		User:         protoUser,
	}, nil
}

func (a *AuthSvc) RefreshToken(
	ctx context.Context,
	req *richterv1.RefreshTokenRequest,
) (*richterv1.RefreshTokenResponse, error) {
	claims, err := a.jwt.ValidateToken(req.GetRefreshToken())
	if err != nil {
		err = connect.NewError(connect.CodeUnauthenticated, err)
		a.log.ErrorContext(ctx, "auth service failed", svc.LogAttrs("RefreshToken.ValidateToken", err)...)
		return nil, err
	}

	if claims.TokenType != jwtv1.TokenType_TOKEN_TYPE_REFRESH {
		err = connect.NewError(connect.CodeUnauthenticated, fmt.Errorf("invalid token type"))
		a.log.ErrorContext(ctx, "auth service failed", svc.LogAttrs("RefreshToken.CheckTokenType", err)...)
		return nil, err
	}

	id, err := svc.ParseUUID(claims.GetSub())
	if err != nil {
		a.log.ErrorContext(ctx, "auth service failed", svc.LogAttrs("RefreshToken.ParseUUID", err)...)
		return nil, err
	}

	user, err := db.WithConnection(a.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.User, error) {
		return q.GetUserByID(ctx, id)
	})
	if err != nil {
		err = svc.ConnectDBError(err)
		a.log.ErrorContext(ctx, "auth service failed", svc.LogAttrs("RefreshToken.GetUserByID", err)...)
		return nil, err
	}

	if user.Status != gen.UserStatusActive {
		err = connect.NewError(connect.CodePermissionDenied, fmt.Errorf("account is not active"))
		a.log.ErrorContext(ctx, "auth service failed", svc.LogAttrs("RefreshToken.CheckStatus", err)...)
		return nil, err
	}

	protoUser := users.UserToProto(user)

	accessToken, err := a.jwt.GenerateToken(protoUser, a.auth.AccessTokenDuration, jwtv1.TokenType_TOKEN_TYPE_ACCESS)
	if err != nil {
		err = connect.NewError(connect.CodeInternal, err)
		a.log.ErrorContext(ctx, "auth service failed", svc.LogAttrs("RefreshToken.GenerateAccessToken", err)...)
		return nil, err
	}

	newRefreshToken, err := a.jwt.GenerateToken(protoUser, a.auth.RefreshTokenDuration, jwtv1.TokenType_TOKEN_TYPE_REFRESH)
	if err != nil {
		err = connect.NewError(connect.CodeInternal, err)
		a.log.ErrorContext(ctx, "auth service failed", svc.LogAttrs("RefreshToken.GenerateRefreshToken", err)...)
		return nil, err
	}

	return &richterv1.RefreshTokenResponse{
		AccessToken:  accessToken,
		RefreshToken: newRefreshToken,
		ExpiresIn:    int64(a.auth.AccessTokenDuration.Seconds()),
	}, nil
}

func (a *AuthSvc) Logout(
	ctx context.Context,
	req *richterv1.LogoutRequest,
) (*richterv1.LogoutResponse, error) {
	claims, err := a.jwt.ValidateToken(req.GetRefreshToken())
	if err != nil {
		err = connect.NewError(connect.CodeUnauthenticated, err)
		a.log.ErrorContext(ctx, "auth service failed", svc.LogAttrs("Logout.ValidateToken", err)...)
		return nil, err
	}

	if claims.TokenType != jwtv1.TokenType_TOKEN_TYPE_REFRESH {
		err = connect.NewError(connect.CodeUnauthenticated, fmt.Errorf("invalid token type"))
		a.log.ErrorContext(ctx, "auth service failed", svc.LogAttrs("Logout.CheckTokenType", err)...)
		return nil, err
	}

	return &richterv1.LogoutResponse{}, nil
}
