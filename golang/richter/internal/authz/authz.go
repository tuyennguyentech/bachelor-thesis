package authz

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"connectrpc.com/connect"
	jwtv1 "example.com/buf/gen/richter/jwt/v1"
	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/richter/internal"
	"example.com/richter/internal/db"
	"example.com/richter/internal/secure"
	"example.com/richter/internal/svc"
	"example.com/richter/log"
	"example.com/sql/gen"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/samber/do/v2"
)

var Package = do.Package(do.Lazy(NewAuthzSvc))

func init() { Package(internal.Injector) }

type ctxKey struct{}

type AuthzSvc struct {
	jwt *secure.JWTService
	pg  *db.PostgresSvc
	log *log.LogSvc
}

func NewAuthzSvc(i do.Injector) (a *AuthzSvc, err error) {
	a = new(AuthzSvc)
	a.jwt, err = do.Invoke[*secure.JWTService](i)
	if err != nil {
		return nil, fmt.Errorf("JWTService cannot be invoked: %w", err)
	}
	a.pg, err = do.Invoke[*db.PostgresSvc](i)
	if err != nil {
		return nil, fmt.Errorf("PostgresSvc cannot be invoked: %w", err)
	}
	a.log, err = do.Invoke[*log.LogSvc](i)
	if err != nil {
		return nil, fmt.Errorf("LogSvc cannot be invoked: %w", err)
	}
	return
}

// Interceptor parses the Bearer token if present and injects claims into context.
// If a token is present but invalid, the request is rejected immediately.
// Handlers enforce access control by calling Require*.
func (a *AuthzSvc) Interceptor() connect.Interceptor {
	return connect.UnaryInterceptorFunc(func(next connect.UnaryFunc) connect.UnaryFunc {
		return func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
			token, ok := extractBearer(req.Header())
			if ok {
				claims, err := a.jwt.ValidateToken(token)
				if err != nil {
					return nil, connect.NewError(connect.CodeUnauthenticated, err)
				}
				ctx = ContextWithClaims(ctx, claims)
			}
			return next(ctx, req)
		}
	})
}

// RequireAuthenticated returns claims if the request carries a valid token.
func (a *AuthzSvc) RequireAuthenticated(ctx context.Context) (*jwtv1.JWTClaims, error) {
	claims, ok := ClaimsFromCtx(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("unauthenticated"))
	}
	return claims, nil
}

// RequireUserRole returns claims if the authenticated user has any of the given system-level roles.
func (a *AuthzSvc) RequireUserRole(ctx context.Context, roles ...richterv1.UserRole) (*jwtv1.JWTClaims, error) {
	claims, err := a.RequireAuthenticated(ctx)
	if err != nil {
		return nil, err
	}
	for _, r := range roles {
		if claims.GetRole() == r {
			return claims, nil
		}
	}
	return nil, connect.NewError(connect.CodePermissionDenied, errors.New("permission denied"))
}

// RequireSelf returns claims if claims.sub == userID or the user is SYS_ADMIN.
func (a *AuthzSvc) RequireSelf(ctx context.Context, userID string) (*jwtv1.JWTClaims, error) {
	claims, err := a.RequireAuthenticated(ctx)
	if err != nil {
		return nil, err
	}
	if claims.GetSub() == userID || claims.GetRole() == richterv1.UserRole_USER_ROLE_ADMIN {
		return claims, nil
	}
	return nil, connect.NewError(connect.CodePermissionDenied, errors.New("permission denied"))
}

// RequireOrgMember returns claims if the authenticated user is a member of the org (any role).
// SYS_ADMIN bypasses the membership check.
func (a *AuthzSvc) RequireOrgMember(ctx context.Context, orgID pgtype.UUID) (*jwtv1.JWTClaims, error) {
	return a.RequireOrgRole(ctx, orgID,
		gen.OrganizationRoleOwner,
		gen.OrganizationRoleAdmin,
		gen.OrganizationRoleTeacher,
		gen.OrganizationRoleStudent,
	)
}

// RequireOrgRole returns claims if the authenticated user has any of the given org-level roles.
// SYS_ADMIN bypasses the org membership check.
func (a *AuthzSvc) RequireOrgRole(ctx context.Context, orgID pgtype.UUID, roles ...gen.OrganizationRole) (*jwtv1.JWTClaims, error) {
	claims, err := a.RequireAuthenticated(ctx)
	if err != nil {
		return nil, err
	}
	if claims.GetRole() == richterv1.UserRole_USER_ROLE_ADMIN {
		return claims, nil
	}
	userID, err := svc.ParseUUID(claims.GetSub())
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("invalid token subject"))
	}
	member, err := db.WithConnection(a.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.OrganizationMember, error) {
		return q.GetOrganizationMember(ctx, gen.GetOrganizationMemberParams{
			OrganizationID: orgID,
			UserID:         userID,
		})
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, connect.NewError(connect.CodePermissionDenied, errors.New("not a member of this organization"))
		}
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	for _, r := range roles {
		if member.Role == r {
			return claims, nil
		}
	}
	return nil, connect.NewError(connect.CodePermissionDenied, errors.New("insufficient organization role"))
}

// ContextWithClaims injects JWT claims into context. Exported for use in tests.
func ContextWithClaims(ctx context.Context, claims *jwtv1.JWTClaims) context.Context {
	return context.WithValue(ctx, ctxKey{}, claims)
}

// ClaimsFromCtx retrieves JWT claims from context.
func ClaimsFromCtx(ctx context.Context) (*jwtv1.JWTClaims, bool) {
	claims, ok := ctx.Value(ctxKey{}).(*jwtv1.JWTClaims)
	return claims, ok
}

func extractBearer(h http.Header) (string, bool) {
	auth := h.Get("Authorization")
	if !strings.HasPrefix(auth, "Bearer ") {
		return "", false
	}
	return strings.TrimPrefix(auth, "Bearer "), true
}
