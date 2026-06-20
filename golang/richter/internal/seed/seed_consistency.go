package seed

import (
	"context"
	"fmt"
	"strings"

	"example.com/richter/internal/db"
	"example.com/richter/internal/svc/ai/segment"
	"example.com/sql/gen"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

// assertSeedConsistency fails the seed if any analyzed lesson is internally
// inconsistent. The invariant enforced: a lesson that has any chunk OR any
// interaction in Postgres MUST have a transcript + segments in FoundationDB, and
// every interaction MUST attach to a real chunk (chunk_id NOT NULL). This is the
// safety net that guarantees the seeder never leaves the divergent FDB/Postgres
// state the old direct-injection path could (chunks/exercises without transcript).
func (s *SeederSvc) assertSeedConsistency(ctx context.Context) error {
	// Lessons that have any chunk or any interaction.
	lessonIDs, err := db.WithConnection(s.pg, ctx, func(_ *gen.Queries, conn *pgxpool.Conn) ([]pgtype.UUID, error) {
		rows, err := conn.Query(ctx, `
			SELECT lesson_id FROM lesson_transcript_chunks
			UNION
			SELECT lesson_id FROM lesson_interactions`)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		var ids []pgtype.UUID
		for rows.Next() {
			var id pgtype.UUID
			if err := rows.Scan(&id); err != nil {
				return nil, err
			}
			ids = append(ids, id)
		}
		return ids, rows.Err()
	})
	if err != nil {
		return fmt.Errorf("list analyzed lessons: %w", err)
	}

	var problems []string
	for _, lid := range lessonIDs {
		lessonIDStr := lid.String()
		if segment.LoadTranscript(s.kv, lessonIDStr) == "" {
			problems = append(problems, fmt.Sprintf("lesson %s: has chunks/interactions but FDB transcript is missing", lessonIDStr))
		}
		if len(segment.LoadSegments(s.kv, lessonIDStr)) == 0 {
			problems = append(problems, fmt.Sprintf("lesson %s: has chunks/interactions but FDB segments are missing", lessonIDStr))
		}
	}

	// Any interaction with a NULL chunk_id is a divergence (hidden from the
	// per-chunk heatmap even though students answer it).
	orphans, err := db.WithConnection(s.pg, ctx, func(_ *gen.Queries, conn *pgxpool.Conn) (int64, error) {
		var n int64
		err := conn.QueryRow(ctx, `SELECT count(*) FROM lesson_interactions WHERE chunk_id IS NULL`).Scan(&n)
		return n, err
	})
	if err != nil {
		return fmt.Errorf("count orphan interactions: %w", err)
	}
	if orphans > 0 {
		problems = append(problems, fmt.Sprintf("%d interaction(s) have a NULL chunk_id", orphans))
	}

	// Every analyzed lesson (has chunks or interactions) must have a source video —
	// a lesson cannot be analyzed without one.
	noVideo, err := db.WithConnection(s.pg, ctx, func(_ *gen.Queries, conn *pgxpool.Conn) ([]string, error) {
		rows, err := conn.Query(ctx, `
			SELECT l.id::text FROM lessons l
			WHERE (l.video_storage_key IS NULL OR l.video_storage_key = '')
			  AND (EXISTS (SELECT 1 FROM lesson_transcript_chunks c WHERE c.lesson_id = l.id)
			    OR EXISTS (SELECT 1 FROM lesson_interactions i WHERE i.lesson_id = l.id))`)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		var ids []string
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				return nil, err
			}
			ids = append(ids, id)
		}
		return ids, rows.Err()
	})
	if err != nil {
		return fmt.Errorf("check analyzed-without-video: %w", err)
	}
	for _, id := range noVideo {
		problems = append(problems, fmt.Sprintf("lesson %s: has analysis (chunks/interactions) but no video_storage_key", id))
	}

	// Every course member must be an active org member of the course's org (global
	// admins excepted — they may manage any org's courses without membership).
	badMembers, err := db.WithConnection(s.pg, ctx, func(_ *gen.Queries, conn *pgxpool.Conn) (int64, error) {
		var n int64
		err := conn.QueryRow(ctx, `
			SELECT count(*)
			FROM course_members cm
			JOIN courses c ON c.id = cm.course_id
			JOIN users u ON u.id = cm.user_id
			LEFT JOIN organization_members om
			  ON om.organization_id = c.organization_id AND om.user_id = cm.user_id
			WHERE u.role <> 'admin'
			  AND (om.status IS NULL OR om.status <> 'active')`).Scan(&n)
		return n, err
	})
	if err != nil {
		return fmt.Errorf("check course-member org membership: %w", err)
	}
	if badMembers > 0 {
		problems = append(problems, fmt.Sprintf("%d course member(s) are not active org members of their course's org", badMembers))
	}

	if len(problems) > 0 {
		return fmt.Errorf("seed data is inconsistent:\n  - %s", strings.Join(problems, "\n  - "))
	}
	s.log.InfoContext(ctx, "seed: consistency check passed", "analyzed_lessons", len(lessonIDs))
	return nil
}
