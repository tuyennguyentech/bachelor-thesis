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

// seedAdmin inserts the production admin user. Idempotent: a unique-violation
// is treated as a no-op so the seeder can be re-run on a populated DB.
func (s *SeederSvc) seedAdmin(ctx context.Context) error {
	hash, err := secure.HashPassword(s.admin.Password)
	if err != nil {
		return fmt.Errorf("hash admin password: %w", err)
	}
	_, err = db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.User, error) {
		return q.CreateUserWithRoleAndStatus(ctx, gen.CreateUserWithRoleAndStatusParams{
			Email:        s.admin.Email,
			PasswordHash: hash,
			FirstName:    s.admin.FirstName,
			LastName:     s.admin.LastName,
			MiddleName:   svc.OptionalStringToPgText(nil),
			Role:         gen.UserRoleAdmin,
			Status:       gen.UserStatusActive,
		})
	})
	if isDuplicate(err) {
		s.log.InfoContext(ctx, "seed: admin already exists, skipping")
		return nil
	}
	if err != nil {
		return fmt.Errorf("create admin: %w", err)
	}
	s.log.InfoContext(ctx, "seed: admin created", "email", s.admin.Email)
	return nil
}
