package seed

import (
	"context"
	"fmt"

	"example.com/richter/internal/db"
	"example.com/richter/internal/secure"
	"example.com/richter/internal/svc"
	"example.com/sql/gen"
	"github.com/jackc/pgx/v5/pgxpool"
)

func (s *SeederSvc) seedDevUsers(ctx context.Context, users []devUserSpec) error {
	for _, u := range users {
		hash, err := secure.HashPassword(u.Password)
		if err != nil {
			return fmt.Errorf("hash password for %s: %w", u.Email, err)
		}
		_, err = db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.User, error) {
			return q.CreateUserWithRoleAndStatus(ctx, gen.CreateUserWithRoleAndStatusParams{
				Email:        u.Email,
				PasswordHash: hash,
				FirstName:    u.FirstName,
				LastName:     u.LastName,
				MiddleName:   svc.OptionalStringToPgText(nil),
				Role:         gen.UserRole(u.Role),
				Status:       gen.UserStatus(u.Status),
			})
		})
		if isDuplicate(err) {
			s.log.InfoContext(ctx, "seed: dev user already exists, skipping", "email", u.Email)
			continue
		}
		if err != nil {
			return fmt.Errorf("create user %s: %w", u.Email, err)
		}
		s.log.InfoContext(ctx, "seed: dev user created", "email", u.Email)
	}
	return nil
}
