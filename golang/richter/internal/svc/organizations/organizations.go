package organizations

import (
	"context"
	"errors"
	"fmt"
	"net/http"

	"connectrpc.com/connect"
	"connectrpc.com/validate"
	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/buf/gen/richter/v1/richterv1connect"
	"example.com/richter/internal"
	"example.com/richter/internal/authz"
	"example.com/richter/internal/db"
	"example.com/richter/internal/svc"
	"example.com/richter/log"
	"example.com/sql/gen"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/samber/do/v2"
)

var Package = do.Package(
	do.Lazy(NewOrganizationsSvc),
)

func init() {
	Package(internal.Injector)
}

type OrganizationsSvc struct {
	pg    *db.PostgresSvc
	log   *log.LogSvc
	authz *authz.AuthzSvc
}

var _ richterv1connect.OrganizationServiceHandler = (*OrganizationsSvc)(nil)

func NewOrganizationsSvc(i do.Injector) (o *OrganizationsSvc, err error) {
	o = new(OrganizationsSvc)
	o.pg, err = do.Invoke[*db.PostgresSvc](i)
	if err != nil {
		return nil, fmt.Errorf("PostgresSvc cannot be invoked: %w", err)
	}
	o.log, err = do.Invoke[*log.LogSvc](i)
	if err != nil {
		return nil, fmt.Errorf("LogSvc cannot be invoked: %w", err)
	}
	o.authz, err = do.Invoke[*authz.AuthzSvc](i)
	if err != nil {
		return nil, fmt.Errorf("AuthzSvc cannot be invoked: %w", err)
	}
	return
}

func (o *OrganizationsSvc) Handler() (string, http.Handler) {
	return richterv1connect.NewOrganizationServiceHandler(
		o,
		connect.WithInterceptors(validate.NewInterceptor(), o.authz.Interceptor()),
	)
}

func (o *OrganizationsSvc) CreateOrganization(
	ctx context.Context,
	req *richterv1.CreateOrganizationRequest,
) (*richterv1.CreateOrganizationResponse, error) {
	if _, err := o.authz.RequireSelf(ctx, req.GetCreatedBy()); err != nil {
		return nil, err
	}
	createdBy, err := svc.ParseUUID(req.GetCreatedBy())
	if err != nil {
		o.log.ErrorContext(ctx, "organizations service failed", svc.LogAttrs("CreateOrganization.ParseUUID", err)...)
		return nil, err
	}

	org, err := db.WithCommitTx(o.pg, ctx, func(q *gen.Queries, _ pgx.Tx) (gen.Organization, error) {
		org, err := q.CreateOrganization(ctx, gen.CreateOrganizationParams{
			CreatedBy: createdBy,
			Name:      req.GetName(),
			Slug:      req.GetSlug(),
		})
		if err != nil {
			return gen.Organization{}, err
		}
		_, err = q.AddOrganizationMember(ctx, gen.AddOrganizationMemberParams{
			OrganizationID: org.ID,
			UserID:         createdBy,
			Role:           gen.OrganizationRoleOwner,
			Status:         gen.MemberStatusActive,
		})
		return org, err
	})
	if err != nil {
		err = svc.ConnectDBError(err)
		o.log.ErrorContext(ctx, "organizations service failed", svc.LogAttrs("CreateOrganization", err)...)
		return nil, err
	}
	return &richterv1.CreateOrganizationResponse{Organization: OrganizationToProto(org)}, nil
}

func (o *OrganizationsSvc) GetOrganizationById(
	ctx context.Context,
	req *richterv1.GetOrganizationByIdRequest,
) (*richterv1.GetOrganizationByIdResponse, error) {
	if _, err := o.authz.RequireAuthenticated(ctx); err != nil {
		return nil, err
	}
	id, err := svc.ParseUUID(req.GetId())
	if err != nil {
		o.log.ErrorContext(ctx, "organizations service failed", svc.LogAttrs("GetOrganizationById.ParseUUID", err)...)
		return nil, err
	}

	org, err := db.WithConnection(o.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.Organization, error) {
		return q.GetOrganizationByID(ctx, id)
	})
	if err != nil {
		err = svc.ConnectDBError(err)
		o.log.ErrorContext(ctx, "organizations service failed", svc.LogAttrs("GetOrganizationById", err)...)
		return nil, err
	}
	return &richterv1.GetOrganizationByIdResponse{Organization: OrganizationToProto(org)}, nil
}

func (o *OrganizationsSvc) GetOrganizationBySlug(
	ctx context.Context,
	req *richterv1.GetOrganizationBySlugRequest,
) (*richterv1.GetOrganizationBySlugResponse, error) {
	if _, err := o.authz.RequireAuthenticated(ctx); err != nil {
		return nil, err
	}
	org, err := db.WithConnection(o.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.Organization, error) {
		return q.GetOrganizationBySlug(ctx, req.GetSlug())
	})
	if err != nil {
		err = svc.ConnectDBError(err)
		o.log.ErrorContext(ctx, "organizations service failed", svc.LogAttrs("GetOrganizationBySlug", err)...)
		return nil, err
	}
	return &richterv1.GetOrganizationBySlugResponse{Organization: OrganizationToProto(org)}, nil
}

func (o *OrganizationsSvc) ListOrganizations(
	ctx context.Context,
	req *richterv1.ListOrganizationsRequest,
) (*richterv1.ListOrganizationsResponse, error) {
	if _, err := o.authz.RequireUserRole(ctx, richterv1.UserRole_USER_ROLE_ADMIN); err != nil {
		return nil, err
	}

	var orgs []gen.Organization
	var err error
	if q := req.GetQuery(); q != "" {
		var org gen.Organization
		if id, uuidErr := svc.ParseUUID(q); uuidErr == nil {
			org, err = db.WithConnection(o.pg, ctx, func(queries *gen.Queries, _ *pgxpool.Conn) (gen.Organization, error) {
				return queries.GetOrganizationByID(ctx, id)
			})
		} else {
			org, err = db.WithConnection(o.pg, ctx, func(queries *gen.Queries, _ *pgxpool.Conn) (gen.Organization, error) {
				return queries.GetOrganizationBySlug(ctx, q)
			})
		}
		if err == nil {
			orgs = []gen.Organization{org}
		} else if errors.Is(err, pgx.ErrNoRows) {
			orgs, err = []gen.Organization{}, nil
		}
	} else {
		orgs, err = db.WithConnection(o.pg, ctx, func(queries *gen.Queries, _ *pgxpool.Conn) ([]gen.Organization, error) {
			return queries.ListOrganizations(ctx, gen.ListOrganizationsParams{
				Limit:  req.GetLimit(),
				Offset: req.GetOffset(),
			})
		})
	}
	if err != nil {
		err = svc.ConnectDBError(err)
		o.log.ErrorContext(ctx, "organizations service failed", svc.LogAttrs("ListOrganizations", err)...)
		return nil, err
	}

	out := make([]*richterv1.Organization, 0, len(orgs))
	for _, org := range orgs {
		out = append(out, OrganizationToProto(org))
	}
	return &richterv1.ListOrganizationsResponse{Organizations: out}, nil
}

func (o *OrganizationsSvc) ListOrganizationsByUser(
	ctx context.Context,
	req *richterv1.ListOrganizationsByUserRequest,
) (*richterv1.ListOrganizationsByUserResponse, error) {
	if _, err := o.authz.RequireSelf(ctx, req.GetUserId()); err != nil {
		return nil, err
	}
	userID, err := svc.ParseUUID(req.GetUserId())
	if err != nil {
		o.log.ErrorContext(ctx, "organizations service failed", svc.LogAttrs("ListOrganizationsByUser.ParseUUID", err)...)
		return nil, err
	}

	orgs, err := db.WithConnection(o.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.Organization, error) {
		return q.ListOrganizationsByUser(ctx, gen.ListOrganizationsByUserParams{
			CreatedBy: userID,
			Limit:     req.GetLimit(),
			Offset:    req.GetOffset(),
		})
	})
	if err != nil {
		err = svc.ConnectDBError(err)
		o.log.ErrorContext(ctx, "organizations service failed", svc.LogAttrs("ListOrganizationsByUser", err)...)
		return nil, err
	}

	out := make([]*richterv1.Organization, 0, len(orgs))
	for _, org := range orgs {
		out = append(out, OrganizationToProto(org))
	}
	return &richterv1.ListOrganizationsByUserResponse{Organizations: out}, nil
}

func (o *OrganizationsSvc) UpdateOrganization(
	ctx context.Context,
	req *richterv1.UpdateOrganizationRequest,
) (*richterv1.UpdateOrganizationResponse, error) {
	id, err := svc.ParseUUID(req.GetId())
	if err != nil {
		o.log.ErrorContext(ctx, "organizations service failed", svc.LogAttrs("UpdateOrganization.ParseUUID", err)...)
		return nil, err
	}
	if _, err := o.authz.RequireOrgRole(ctx, id, gen.OrganizationRoleAdmin, gen.OrganizationRoleOwner); err != nil {
		return nil, err
	}

	org, err := db.WithConnection(o.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.Organization, error) {
		return q.UpdateOrganization(ctx, gen.UpdateOrganizationParams{
			ID:   id,
			Name: req.GetName(),
			Slug: req.GetSlug(),
		})
	})
	if err != nil {
		err = svc.ConnectDBError(err)
		o.log.ErrorContext(ctx, "organizations service failed", svc.LogAttrs("UpdateOrganization", err)...)
		return nil, err
	}
	return &richterv1.UpdateOrganizationResponse{Organization: OrganizationToProto(org)}, nil
}

func (o *OrganizationsSvc) UpdateOrganizationStatus(
	ctx context.Context,
	req *richterv1.UpdateOrganizationStatusRequest,
) (*richterv1.UpdateOrganizationStatusResponse, error) {
	id, err := svc.ParseUUID(req.GetId())
	if err != nil {
		o.log.ErrorContext(ctx, "organizations service failed", svc.LogAttrs("UpdateOrganizationStatus.ParseUUID", err)...)
		return nil, err
	}
	if _, err := o.authz.RequireOrgRole(ctx, id, gen.OrganizationRoleOwner); err != nil {
		return nil, err
	}
	status, err := OrganizationStatusToSQL(req.GetStatus())
	if err != nil {
		o.log.ErrorContext(ctx, "organizations service failed", svc.LogAttrs("UpdateOrganizationStatus.OrganizationStatusToSQL", err)...)
		return nil, err
	}

	org, err := db.WithConnection(o.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.Organization, error) {
		return q.UpdateOrganizationStatus(ctx, gen.UpdateOrganizationStatusParams{
			ID:     id,
			Status: status,
		})
	})
	if err != nil {
		err = svc.ConnectDBError(err)
		o.log.ErrorContext(ctx, "organizations service failed", svc.LogAttrs("UpdateOrganizationStatus", err)...)
		return nil, err
	}
	return &richterv1.UpdateOrganizationStatusResponse{Organization: OrganizationToProto(org)}, nil
}

func (o *OrganizationsSvc) DeleteOrganization(
	ctx context.Context,
	req *richterv1.DeleteOrganizationRequest,
) (*richterv1.DeleteOrganizationResponse, error) {
	id, err := svc.ParseUUID(req.GetId())
	if err != nil {
		o.log.ErrorContext(ctx, "organizations service failed", svc.LogAttrs("DeleteOrganization.ParseUUID", err)...)
		return nil, err
	}
	if _, err := o.authz.RequireOrgRole(ctx, id, gen.OrganizationRoleOwner); err != nil {
		return nil, err
	}

	rowsAffected, err := db.WithConnection(o.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (int64, error) {
		return q.DeleteOrganization(ctx, id)
	})
	if err != nil {
		err = svc.ConnectDBError(err)
		o.log.ErrorContext(ctx, "organizations service failed", svc.LogAttrs("DeleteOrganization", err)...)
		return nil, err
	}
	if rowsAffected == 0 {
		err = connect.NewError(connect.CodeNotFound, fmt.Errorf("organization not found: %s", id.String()))
		o.log.ErrorContext(ctx, "organizations service failed", svc.LogAttrs("DeleteOrganization.NotFound", err)...)
		return nil, err
	}
	return &richterv1.DeleteOrganizationResponse{}, nil
}
