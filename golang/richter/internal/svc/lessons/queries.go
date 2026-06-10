package lessons

import (
	"context"

	"example.com/richter/internal/db"
	"example.com/richter/internal/svc"
	"example.com/sql/gen"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

// fetchModule loads a course module by id. Returns connect-compatible errors.
func (s *LessonsSvc) fetchModule(ctx context.Context, id string) (gen.CourseModule, error) {
	uuid, err := svc.ParseUUID(id)
	if err != nil {
		return gen.CourseModule{}, err
	}
	m, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.CourseModule, error) {
		return q.GetCourseModuleByID(ctx, uuid)
	})
	if err != nil {
		return gen.CourseModule{}, svc.ConnectDBError(err)
	}
	return m, nil
}

func (s *LessonsSvc) fetchCourse(ctx context.Context, id pgtype.UUID) (gen.Course, error) {
	course, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.Course, error) {
		return q.GetCourseByID(ctx, id)
	})
	if err != nil {
		return gen.Course{}, svc.ConnectDBError(err)
	}
	return course, nil
}

func (s *LessonsSvc) fetchLesson(ctx context.Context, id string) (gen.Lesson, error) {
	uuid, err := svc.ParseUUID(id)
	if err != nil {
		return gen.Lesson{}, err
	}
	l, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.Lesson, error) {
		return q.GetLessonByID(ctx, uuid)
	})
	if err != nil {
		return gen.Lesson{}, svc.ConnectDBError(err)
	}
	return l, nil
}
