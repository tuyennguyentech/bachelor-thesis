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

// jwtInterceptor injects JWT claims into context for both unary and streaming RPCs.
type jwtInterceptor struct{ a *AuthzSvc }

// injectClaims parses the Bearer token from h and returns an updated context.
func (i *jwtInterceptor) injectClaims(ctx context.Context, h http.Header) (context.Context, error) {
	token, ok := extractBearer(h)
	if !ok {
		return ctx, nil
	}
	claims, err := i.a.jwt.ValidateToken(token)
	if err != nil {
		return ctx, connect.NewError(connect.CodeUnauthenticated, err)
	}
	if claims.GetTokenType() != jwtv1.TokenType_TOKEN_TYPE_ACCESS {
		return ctx, connect.NewError(connect.CodeUnauthenticated, errors.New("invalid token type"))
	}
	return ContextWithClaims(ctx, claims), nil
}

func (i *jwtInterceptor) WrapUnary(next connect.UnaryFunc) connect.UnaryFunc {
	return func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
		ctx, err := i.injectClaims(ctx, req.Header())
		if err != nil {
			return nil, err
		}
		return next(ctx, req)
	}
}

func (i *jwtInterceptor) WrapStreamingClient(next connect.StreamingClientFunc) connect.StreamingClientFunc {
	return next
}

func (i *jwtInterceptor) WrapStreamingHandler(next connect.StreamingHandlerFunc) connect.StreamingHandlerFunc {
	return func(ctx context.Context, conn connect.StreamingHandlerConn) error {
		ctx, err := i.injectClaims(ctx, conn.RequestHeader())
		if err != nil {
			return err
		}
		return next(ctx, conn)
	}
}

// Interceptor parses the Bearer token if present and injects claims into context.
// If a token is present but invalid, the request is rejected immediately.
// Handlers enforce access control by calling Require*.
func (a *AuthzSvc) Interceptor() connect.Interceptor {
	return &jwtInterceptor{a: a}
}

// RequireAuthenticated returns claims if the request carries a valid token
// from an active account. Disabled or pending accounts are rejected even if
// their token is cryptographically valid.
func (a *AuthzSvc) RequireAuthenticated(ctx context.Context) (*jwtv1.JWTClaims, error) {
	claims, ok := ClaimsFromCtx(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("unauthenticated"))
	}
	if claims.GetStatus() != richterv1.UserStatus_USER_STATUS_ACTIVE {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("account is not active"))
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

// RequireOrgMembershipAnyStatus returns claims if the authenticated user has a
// membership row in the org of ANY status (active, invited, or suspended) — used
// for reading the org's public details so an INVITED user can see which org they
// were invited to before accepting. SYS_ADMIN bypasses the check.
func (a *AuthzSvc) RequireOrgMembershipAnyStatus(ctx context.Context, orgID pgtype.UUID) (*jwtv1.JWTClaims, error) {
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
	_, err = db.WithConnection(a.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.OrganizationMember, error) {
		return q.GetOrganizationMember(ctx, gen.GetOrganizationMemberParams{
			OrganizationID: orgID,
			UserID:         userID,
		})
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, connect.NewError(connect.CodePermissionDenied, errors.New("not a member of this organization"))
		}
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
	return claims, nil
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
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
	if member.Status != gen.MemberStatusActive {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("membership is not active"))
	}
	for _, r := range roles {
		if member.Role == r {
			return claims, nil
		}
	}
	return nil, connect.NewError(connect.CodePermissionDenied, errors.New("insufficient organization role"))
}

// RequireCourseMember returns claims if the authenticated user may access the
// course content (read/open lessons). Bypass rules (always allowed):
//   - system ADMIN (USER_ROLE_ADMIN)
//   - course owner (course.owner_id == caller)
//   - org owner or org admin (active membership)
//   - explicit course member (entry in course_members table)
//
// All other org members receive PermissionDenied.
func (a *AuthzSvc) RequireCourseMember(ctx context.Context, courseID pgtype.UUID) (*jwtv1.JWTClaims, error) {
	claims, err := a.RequireAuthenticated(ctx)
	if err != nil {
		return nil, err
	}
	// SYS_ADMIN bypasses all checks.
	if claims.GetRole() == richterv1.UserRole_USER_ROLE_ADMIN {
		return claims, nil
	}
	userID, err := svc.ParseUUID(claims.GetSub())
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("invalid token subject"))
	}
	info, err := db.WithConnection(a.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.GetCourseAccessInfoByCourseIDRow, error) {
		return q.GetCourseAccessInfoByCourseID(ctx, courseID)
	})
	if err != nil {
		// SYS_ADMIN already returned above, so only non-admins reach here.
		// Obscure existence: a missing course is reported as a permission error
		// rather than not-found so outsiders can't probe which courses exist.
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, connect.NewError(connect.CodePermissionDenied, errors.New("course not found or access denied"))
		}
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
	// Course owner always passes.
	if info.OwnerID == userID {
		return claims, nil
	}
	// Org owner/admin always passes.
	orgMember, err := db.WithConnection(a.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.OrganizationMember, error) {
		return q.GetOrganizationMember(ctx, gen.GetOrganizationMemberParams{
			OrganizationID: info.OrganizationID,
			UserID:         userID,
		})
	})
	if err == nil && orgMember.Status == gen.MemberStatusActive {
		if orgMember.Role == gen.OrganizationRoleOwner || orgMember.Role == gen.OrganizationRoleAdmin {
			return claims, nil
		}
	}
	// Explicit course member passes.
	isMember, err := db.WithConnection(a.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (bool, error) {
		return q.IsCourseMember(ctx, gen.IsCourseMemberParams{
			CourseID: courseID,
			UserID:   userID,
		})
	})
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
	if isMember {
		return claims, nil
	}
	return nil, connect.NewError(connect.CodePermissionDenied, errors.New("not a member of this course"))
}

// RequireCourseMemberByLesson resolves the course from the lesson and delegates
// to RequireCourseMember.
func (a *AuthzSvc) RequireCourseMemberByLesson(ctx context.Context, lessonID pgtype.UUID) (*jwtv1.JWTClaims, error) {
	claims, err := a.RequireAuthenticated(ctx)
	if err != nil {
		return nil, err
	}
	// SYS_ADMIN bypasses the course check entirely, and we skip lesson
	// resolution so a missing lesson surfaces as the handler's own NotFound
	// (admins are allowed to learn that a resource does not exist).
	if claims.GetRole() == richterv1.UserRole_USER_ROLE_ADMIN {
		return claims, nil
	}
	info, err := db.WithConnection(a.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.GetCourseAccessInfoByLessonIDRow, error) {
		return q.GetCourseAccessInfoByLessonID(ctx, lessonID)
	})
	if err != nil {
		// For non-admins, obscure existence: a missing lesson is reported as a
		// permission error so outsiders can't probe which lesson IDs exist.
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, connect.NewError(connect.CodePermissionDenied, errors.New("lesson not found or access denied"))
		}
		return nil, connect.NewError(connect.CodeInternal, errors.New("internal error"))
	}
	return a.RequireCourseMember(ctx, info.CourseID)
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
