package seed

import (
	"context"
	"errors"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	jwtv1 "example.com/buf/gen/richter/jwt/v1"
	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/richter/internal"
	"example.com/richter/internal/authz"
	"example.com/richter/internal/db"
	"example.com/richter/internal/svc"
	"example.com/richter/internal/svc/ai"
	"example.com/richter/internal/svc/ai/generation"
	"example.com/richter/internal/svc/ai/segment"
	"example.com/richter/internal/svc/coursemodules"
	coursesvc "example.com/richter/internal/svc/courses"
	"example.com/richter/internal/svc/interactions"
	"example.com/richter/internal/svc/lessons"
	"example.com/sql/gen"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/minio/minio-go/v7"
	"github.com/samber/do/v2"
)

// mlVideoDir is where the ML playlist videos are expected for the real analysis
// pipeline (mlCourseTitle / mlOrgSlug are declared in dev_attempts.go).
const mlVideoDir = "seed-assets/videos/ml"

// errSeedVideoUnavailable marks a real-analysis failure caused by the local
// source video being absent/unreadable — an EXTERNAL data dependency (e.g. the ML
// playlist hasn't been downloaded). The caller treats it as a soft failure and
// falls back to the committed golden fixtures; it never aborts the seed. Genuine
// pipeline failures (Whisper/Gemini/DB) are NOT wrapped with this and stay fatal.
var errSeedVideoUnavailable = errors.New("seed: source video unavailable")

var courseStatusProto = map[string]richterv1.CourseStatus{
	"draft":     richterv1.CourseStatus_COURSE_STATUS_DRAFT,
	"published": richterv1.CourseStatus_COURSE_STATUS_PUBLISHED,
	"archived":  richterv1.CourseStatus_COURSE_STATUS_ARCHIVED,
}

func (s *SeederSvc) seedDevCourses(ctx context.Context, courses []devCourseSpec, videosByKey map[string]string) error {
	// Courses/modules/lessons are created THROUGH the service layer (synthesized
	// auth), not raw sqlc: the course OWNER creates the course (CreateCourse uses the
	// caller's claims as owner + auto-enrols them as course TEACHER), modules/lessons
	// follow as the owner, and publishing runs as the org owner (needs org owner/admin).
	coursesSvc, err := do.Invoke[*coursesvc.CoursesSvc](internal.Injector)
	if err != nil {
		return fmt.Errorf("invoke CoursesSvc: %w", err)
	}
	modulesSvc, err := do.Invoke[*coursemodules.CourseModulesSvc](internal.Injector)
	if err != nil {
		return fmt.Errorf("invoke CourseModulesSvc: %w", err)
	}
	lessonsSvc, err := do.Invoke[*lessons.LessonsSvc](internal.Injector)
	if err != nil {
		return fmt.Errorf("invoke LessonsSvc: %w", err)
	}
	// External-data dependency check (warn, never fail): the ML course's real
	// Whisper+Gemini pipeline needs the playlist videos downloaded into
	// seed-assets/videos/ml (scripts/seed/download-ml-videos.py). Warn up front if
	// they're missing so it's clear the seed is using golden fixtures instead of
	// running the real pipeline.
	s.warnIfMLVideosMissing(ctx, courses)

	type orgCache struct {
		org     gen.Organization
		courses map[string]gen.Course // title → existing course row (declarative desired-state)
	}
	orgs := make(map[string]*orgCache)

	for _, c := range courses {
		if _, ok := orgs[c.OrgSlug]; !ok {
			org, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.Organization, error) {
				return q.GetOrganizationBySlug(ctx, c.OrgSlug)
			})
			if err != nil {
				return fmt.Errorf("lookup org %s: %w", c.OrgSlug, err)
			}
			existing, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.Course, error) {
				return q.ListCoursesByOrg(ctx, gen.ListCoursesByOrgParams{
					OrganizationID: org.ID,
					Limit:          1000,
					Offset:         0,
				})
			})
			if err != nil {
				return fmt.Errorf("list courses for org %s: %w", c.OrgSlug, err)
			}
			byTitle := make(map[string]gen.Course, len(existing))
			for _, e := range existing {
				byTitle[e.Title] = e
			}
			orgs[c.OrgSlug] = &orgCache{org: org, courses: byTitle}
		}
		oc := orgs[c.OrgSlug]

		owner, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.User, error) {
			return q.GetUserByEmail(ctx, c.OwnerEmail)
		})
		if err != nil {
			return fmt.Errorf("lookup owner %s for course %q: %w", c.OwnerEmail, c.Title, err)
		}

		// Act as the course OWNER (org owner/admin/teacher) for create + module/lesson
		// updates below; status changes require org OWNER/ADMIN → act as the org owner.
		ownerCtx := authz.ContextWithClaims(ctx, &jwtv1.JWTClaims{
			Sub:    uuidStr(owner.ID),
			Role:   richterv1.UserRole_USER_ROLE_NORMAL,
			Status: richterv1.UserStatus_USER_STATUS_ACTIVE,
		})
		orgOwnerCtx := authz.ContextWithClaims(ctx, &jwtv1.JWTClaims{
			Sub:    uuidStr(oc.org.CreatedBy),
			Role:   richterv1.UserRole_USER_ROLE_NORMAL,
			Status: richterv1.UserStatus_USER_STATUS_ACTIVE,
		})
		wantStatus := courseStatusProto[c.Status]

		// Declarative desired-state: find-or-create the course, then converge its
		// description + status. Descending into modules/lessons below both fills any a
		// crashed earlier run left missing (self-healing) and converges their metadata.
		var courseID pgtype.UUID
		if cur, ok := oc.courses[c.Title]; ok {
			courseID = cur.ID
			curDesc := ""
			if cur.Description.Valid {
				curDesc = cur.Description.String
			}
			if curDesc != c.Description {
				if _, err := coursesSvc.UpdateCourse(ownerCtx, &richterv1.UpdateCourseRequest{
					Id: uuidStr(courseID), Title: c.Title, Description: c.Description,
				}); err != nil {
					return fmt.Errorf("converge course %q description: %w", c.Title, err)
				}
				s.log.InfoContext(ctx, "seed: dev course description converged", "org", c.OrgSlug, "title", c.Title)
			}
			if coursesvc.CourseStatusToProto(cur.Status) != wantStatus {
				if _, err := coursesSvc.UpdateCourseStatus(orgOwnerCtx, &richterv1.UpdateCourseStatusRequest{
					Id: uuidStr(courseID), Status: wantStatus,
				}); err != nil {
					return fmt.Errorf("converge course %q status: %w", c.Title, err)
				}
				s.log.InfoContext(ctx, "seed: dev course status converged", "org", c.OrgSlug, "title", c.Title, "status", c.Status)
			}
		} else {
			createResp, err := coursesSvc.CreateCourse(ownerCtx, &richterv1.CreateCourseRequest{
				OrganizationId: uuidStr(oc.org.ID),
				OwnerId:        uuidStr(owner.ID),
				Title:          c.Title,
				Description:    c.Description,
			})
			if err != nil {
				return fmt.Errorf("create course %q in org %s: %w", c.Title, c.OrgSlug, err)
			}
			courseID, err = svc.ParseUUID(createResp.GetCourse().GetId())
			if err != nil {
				return fmt.Errorf("parse course id for %q: %w", c.Title, err)
			}
			if wantStatus == richterv1.CourseStatus_COURSE_STATUS_PUBLISHED {
				if _, err := coursesSvc.UpdateCourseStatus(orgOwnerCtx, &richterv1.UpdateCourseStatusRequest{
					Id:     uuidStr(courseID),
					Status: richterv1.CourseStatus_COURSE_STATUS_PUBLISHED,
				}); err != nil {
					return fmt.Errorf("publish course %q: %w", c.Title, err)
				}
			}
		}

		// Existing modules + lessons of this course, keyed for find-or-create-converge.
		existingModules, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.CourseModule, error) {
			return q.ListCourseModules(ctx, gen.ListCourseModulesParams{CourseID: courseID, Limit: 1000, Offset: 0})
		})
		if err != nil {
			return fmt.Errorf("list modules for course %q: %w", c.Title, err)
		}
		moduleByTitle := make(map[string]gen.CourseModule, len(existingModules))
		for _, mm := range existingModules {
			moduleByTitle[mm.Title] = mm
		}
		existingLessons, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.Lesson, error) {
			return q.ListLessonsByCourse(ctx, gen.ListLessonsByCourseParams{CourseID: courseID, Limit: 5000, Offset: 0})
		})
		if err != nil {
			return fmt.Errorf("list lessons for course %q: %w", c.Title, err)
		}
		lessonByKey := make(map[string]gen.Lesson, len(existingLessons))
		for _, ll := range existingLessons {
			lessonByKey[uuidStr(ll.ModuleID)+"\x00"+ll.Title] = ll
		}

		for i, m := range c.Modules {
			var moduleID pgtype.UUID
			if cur, ok := moduleByTitle[m.Title]; ok {
				moduleID = cur.ID
				if cur.OrderIndex != int32(i) {
					if _, err := modulesSvc.UpdateCourseModule(ownerCtx, &richterv1.UpdateCourseModuleRequest{
						Id: uuidStr(cur.ID), Title: m.Title, OrderIndex: int32(i),
					}); err != nil {
						return fmt.Errorf("converge module %q order in course %q: %w", m.Title, c.Title, err)
					}
				}
			} else {
				modResp, err := modulesSvc.CreateCourseModule(ownerCtx, &richterv1.CreateCourseModuleRequest{
					CourseId:   uuidStr(courseID),
					Title:      m.Title,
					OrderIndex: int32(i),
				})
				if err != nil {
					return fmt.Errorf("create module %d %q for course %q: %w", i, m.Title, c.Title, err)
				}
				moduleID, err = svc.ParseUUID(modResp.GetModule().GetId())
				if err != nil {
					return fmt.Errorf("parse module id %q: %w", m.Title, err)
				}
			}

			for j, l := range m.Lessons {
				var lessonID pgtype.UUID
				if cur, ok := lessonByKey[uuidStr(moduleID)+"\x00"+l.Title]; ok {
					lessonID = cur.ID
					curDesc := ""
					if cur.Description.Valid {
						curDesc = cur.Description.String
					}
					if curDesc != l.Description || cur.OrderIndex != int32(j) {
						if _, err := lessonsSvc.UpdateLesson(ownerCtx, &richterv1.UpdateLessonRequest{
							Id: uuidStr(cur.ID), Title: l.Title, Description: l.Description, OrderIndex: int32(j),
						}); err != nil {
							return fmt.Errorf("converge lesson %q in module %q: %w", l.Title, m.Title, err)
						}
					}
				} else {
					lesResp, err := lessonsSvc.CreateLesson(ownerCtx, &richterv1.CreateLessonRequest{
						ModuleId:    uuidStr(moduleID),
						Title:       l.Title,
						Description: l.Description,
						OrderIndex:  int32(j),
					})
					if err != nil {
						return fmt.Errorf("create lesson %d %q in module %q: %w", j, l.Title, m.Title, err)
					}
					lessonID, err = svc.ParseUUID(lesResp.GetLesson().GetId())
					if err != nil {
						return fmt.Errorf("parse lesson id %q: %w", l.Title, err)
					}
				}

				// Real duration (seconds) of the demo clip actually mapped to this
				// lesson, probed from the local source file. The golden-fixture chunk
				// and interaction timestamps are authored for the ORIGINAL lecture
				// length (l.DurationSecs), which is longer than the short demo clip —
				// so we fit them to this real duration (below) and store it as the
				// lesson duration. 0 = unknown → keep the authored values (no scaling).
				var videoDurSecs float64
				if l.VideoKey != "" {
					if lp, ok := videosByKey[l.VideoKey]; ok {
						videoDurSecs = probeVideoDurationSecs(ctx, lp)
					}
				}

				if l.VideoKey != "" {
					durationSecs := l.DurationSecs
					if videoDurSecs > 0 {
						durationSecs = int32(math.Round(videoDurSecs))
					}
					// Direct write (documented exception): LessonsSvc.UpdateLessonVideo
					// guards on the S3 object already existing, but the dev.videos upload
					// step runs AFTER dev.courses — the object isn't there yet at this
					// point, so we set the key + probed duration via the query directly.
					_, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.Lesson, error) {
						return q.UpdateLessonVideo(ctx, gen.UpdateLessonVideoParams{
							ID:              lessonID,
							VideoStorageKey: pgtype.Text{String: l.VideoKey, Valid: true},
							DurationSeconds: pgtype.Int4{Int32: durationSecs, Valid: true},
						})
					})
					if err != nil {
						return fmt.Errorf("set video for lesson %q: %w", l.Title, err)
					}
				}

				if l.Analysis != nil {
					runReal := false
					if c.Title == mlCourseTitle && l.VideoKey != "" && s.pg.Config().ConnConfig.Database != "dyadia_test" {
						if _, err := os.Stat(filepath.Join(mlVideoDir, filepath.Base(l.VideoKey))); err == nil {
							runReal = true
						}
					}

					if runReal {
						s.log.InfoContext(ctx, "seed: running real video analysis pipeline", "lesson", l.Title)
						if err := s.seedLessonRealAnalysis(ctx, lessonID, owner.ID, l); err != nil {
							if !errors.Is(err, errSeedVideoUnavailable) {
								// Genuine pipeline failure (Whisper/Gemini/DB) is a SEED
								// error — stop so it's fixed, don't silently skip.
								return fmt.Errorf("seed real analysis for lesson %q: %w", l.Title, err)
							}
							// EXTERNAL-DEP case only: the source video is missing/unreadable
							// → warn and fall back to golden fixtures (don't fail the seed).
							s.log.WarnContext(ctx, "seed: ML video unavailable at analysis time, falling back to golden fixtures",
								"lesson", l.Title, "err", err)
							if err := s.seedLessonAnalysis(ctx, lessonID, owner.ID, l.Analysis, videoDurSecs); err != nil {
								return fmt.Errorf("seed fixtures fallback for lesson %q: %w", l.Title, err)
							}
						}
					} else {
						if err := s.seedLessonAnalysis(ctx, lessonID, owner.ID, l.Analysis, videoDurSecs); err != nil {
							return fmt.Errorf("seed analysis for lesson %q: %w", l.Title, err)
						}
					}
				}
			}
		}
		oc.courses[c.Title] = gen.Course{ID: courseID}
		s.log.InfoContext(ctx, "seed: dev course reconciled", "org", c.OrgSlug, "title", c.Title,
			"modules", len(c.Modules))
	}
	return nil
}

// warnIfMLVideosMissing logs ONE warning per ML course when the local playlist
// videos required for the real Whisper+Gemini pipeline are absent or only partly
// present. It never errors — the seed transparently falls back to the committed
// golden fixtures (the missing-data path is a warning, not a failure).
func (s *SeederSvc) warnIfMLVideosMissing(ctx context.Context, courses []devCourseSpec) {
	if s.pg.Config().ConnConfig.Database == "dyadia_test" {
		return // test DB always uses golden fixtures by design — no videos needed.
	}
	for _, c := range courses {
		if c.Title != mlCourseTitle {
			continue
		}
		var want, have int
		for _, m := range c.Modules {
			for _, l := range m.Lessons {
				if l.VideoKey == "" || l.Analysis == nil {
					continue
				}
				want++
				if _, err := os.Stat(filepath.Join(mlVideoDir, filepath.Base(l.VideoKey))); err == nil {
					have++
				}
			}
		}
		if want > 0 && have < want {
			s.log.WarnContext(ctx,
				"seed: ML course videos not fully downloaded — real Whisper+Gemini analysis will be SKIPPED for the missing lessons and golden fixtures used instead; run scripts/seed/download-ml-videos.py to enable real analysis",
				"dir", mlVideoDir, "present", have, "expected", want)
		}
	}
}

// seedDevLessonVideoKeys patches video_storage_key on existing lessons that have
// a video_key in the seed data but none in the DB (idempotent: skips if already set).
func (s *SeederSvc) seedDevLessonVideoKeys(ctx context.Context, courses []devCourseSpec) error {
	for _, c := range courses {
		org, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.Organization, error) {
			return q.GetOrganizationBySlug(ctx, c.OrgSlug)
		})
		if err != nil {
			return fmt.Errorf("lookup org %s: %w", c.OrgSlug, err)
		}

		dbCourses, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.Course, error) {
			return q.ListCoursesByOrg(ctx, gen.ListCoursesByOrgParams{OrganizationID: org.ID, Limit: 1000, Offset: 0})
		})
		if err != nil {
			return fmt.Errorf("list courses for org %s: %w", c.OrgSlug, err)
		}
		var courseID pgtype.UUID
		for _, dc := range dbCourses {
			if dc.Title == c.Title {
				courseID = dc.ID
				break
			}
		}
		if !courseID.Valid {
			continue
		}

		dbModules, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.CourseModule, error) {
			return q.ListCourseModules(ctx, gen.ListCourseModulesParams{CourseID: courseID, Limit: 100, Offset: 0})
		})
		if err != nil {
			return fmt.Errorf("list modules for course %q: %w", c.Title, err)
		}

		for _, m := range c.Modules {
			var moduleID pgtype.UUID
			for _, dm := range dbModules {
				if dm.Title == m.Title {
					moduleID = dm.ID
					break
				}
			}
			if !moduleID.Valid {
				continue
			}

			dbLessons, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.Lesson, error) {
				return q.ListLessons(ctx, gen.ListLessonsParams{ModuleID: moduleID, Limit: 100, Offset: 0})
			})
			if err != nil {
				return fmt.Errorf("list lessons for module %q: %w", m.Title, err)
			}

			for _, l := range m.Lessons {
				if l.VideoKey == "" {
					continue
				}
				for _, dl := range dbLessons {
					if dl.Title != l.Title {
						continue
					}
					if dl.VideoStorageKey.Valid {
						break
					}
					_, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.Lesson, error) {
						return q.UpdateLessonVideo(ctx, gen.UpdateLessonVideoParams{
							ID:              dl.ID,
							VideoStorageKey: pgtype.Text{String: l.VideoKey, Valid: true},
							DurationSeconds: pgtype.Int4{Int32: l.DurationSecs, Valid: true},
						})
					})
					if err != nil {
						return fmt.Errorf("set video key for lesson %q: %w", l.Title, err)
					}
					s.log.InfoContext(ctx, "seed: video key set for lesson", "lesson", l.Title, "key", l.VideoKey)
					break
				}
			}
		}
	}
	return nil
}

// deriveSeedSegments splits a plain transcript into sentence-level pieces and
// distributes them across [0, totalDuration] proportional to length, so seeded
// lessons have an interactive, video-synced transcript. Returns nil when there
// is no usable duration (no chunks) so callers fall back to plain text.
func deriveSeedSegments(transcript string, totalDuration float64) []segment.Segment {
	if totalDuration <= 0 {
		return nil
	}
	pieces := splitSentences(transcript)
	if len(pieces) == 0 {
		return nil
	}
	totalChars := 0
	for _, p := range pieces {
		totalChars += len([]rune(p))
	}
	if totalChars == 0 {
		return nil
	}
	segs := make([]segment.Segment, 0, len(pieces))
	cumChars := 0
	for _, p := range pieces {
		start := totalDuration * float64(cumChars) / float64(totalChars)
		cumChars += len([]rune(p))
		end := totalDuration * float64(cumChars) / float64(totalChars)
		segs = append(segs, segment.Segment{
			StartSeconds: float32(start),
			EndSeconds:   float32(end),
			Text:         p,
		})
	}
	return segs
}

// splitSentences breaks text into trimmed, non-empty sentence-ish pieces on
// sentence-final punctuation and newlines.
func splitSentences(text string) []string {
	var out []string
	var b strings.Builder
	flush := func() {
		if s := strings.TrimSpace(b.String()); s != "" {
			out = append(out, s)
		}
		b.Reset()
	}
	for _, r := range text {
		b.WriteRune(r)
		if r == '.' || r == '!' || r == '?' || r == '\n' {
			flush()
		}
	}
	flush()
	return out
}

// probeVideoDurationSecs returns the media duration (seconds) of a local file via
// ffprobe, or 0 when the file is missing or ffprobe is unavailable/fails. Unlike the
// gen-ml-spec probe it has NO non-zero fallback: 0 means "unknown" so the caller
// keeps the authored timestamps rather than scaling them to a bogus length.
func probeVideoDurationSecs(ctx context.Context, path string) float64 {
	if path == "" {
		return 0
	}
	if _, err := os.Stat(path); err != nil {
		return 0
	}
	out, err := exec.CommandContext(ctx, "ffprobe", "-v", "error",
		"-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", path).Output()
	if err != nil {
		return 0
	}
	d, err := strconv.ParseFloat(strings.TrimSpace(string(out)), 64)
	if err != nil || d <= 0 {
		return 0
	}
	return d
}

// resetLessonAnalysis removes a lesson's existing interactions, transcript chunks
// and seeded task rows so seedLessonAnalysis can rewrite them idempotently. On a
// fresh seed this is a harmless no-op.
func (s *SeederSvc) resetLessonAnalysis(ctx context.Context, lessonID pgtype.UUID) error {
	existing, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.LessonInteraction, error) {
		return q.ListLessonInteractions(ctx, gen.ListLessonInteractionsParams{LessonID: lessonID, Limit: 10000, Offset: 0})
	})
	if err != nil {
		return fmt.Errorf("list interactions: %w", err)
	}
	for _, it := range existing {
		if err := db.WithConnectionExec(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) error {
			return q.DeleteLessonInteraction(ctx, it.ID)
		}); err != nil {
			return fmt.Errorf("delete interaction %s: %w", it.ID.String(), err)
		}
	}
	// Reap each chunk's FDB transcript BEFORE dropping the Postgres chunk rows.
	// RunExtract's own stale-reap derives chunk IDs from those PG rows, so if we
	// delete the rows first it finds nothing and the old chunk-keyed FDB entries
	// leak (new chunks are re-created under fresh UUIDs on every re-seed/rescale).
	chunkRows, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.LessonTranscriptChunk, error) {
		return q.ListLessonTranscriptChunks(ctx, gen.ListLessonTranscriptChunksParams{LessonID: lessonID, Limit: 10000, Offset: 0})
	})
	if err != nil {
		return fmt.Errorf("list chunks for FDB reap: %w", err)
	}
	for _, c := range chunkRows {
		// Best-effort reap: a leaked chunk-keyed FDB entry doesn't corrupt the re-seed
		// (new chunks get fresh UUIDs), so we don't abort on it — but a silent drop
		// would hide an FDB outage, so surface it as a warning instead of swallowing.
		if err := segment.DeleteChunkTranscript(s.kv, c.ID.String()); err != nil {
			s.log.WarnContext(ctx, "seed: failed to reap stale FDB chunk transcript", "chunk", c.ID.String(), "err", err)
		}
	}
	if err := db.WithConnectionExec(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) error {
		return q.DeleteLessonTranscriptChunks(ctx, lessonID)
	}); err != nil {
		return fmt.Errorf("delete chunks: %w", err)
	}
	if err := db.WithConnectionExec(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) error {
		return q.DeleteTasksForLesson(ctx, lessonID)
	}); err != nil {
		return fmt.Errorf("delete tasks: %w", err)
	}
	return nil
}

// RescaleFixtures re-runs the golden-fixture analysis for every NON-ML demo lesson
// against the CURRENT database, fitting the fixture timeline to each lesson's real
// mapped-video duration (see seedLessonAnalysis). It exists to repair a database that
// was seeded before that fit was added — WITHOUT a destructive full reseed: the ML
// course (real Whisper/Gemini analysis) is deliberately skipped, so its data and the
// FoundationDB cluster are left untouched (no root re-configure, no GPU rerun).
func (s *SeederSvc) RescaleFixtures(ctx context.Context) (err error) {
	// Any genuine error aborts the run: log it at ERROR (log-and-stop) on every return
	// path. External-dep degradations are warned+continued inside the loop, never here.
	defer func() {
		if err != nil {
			s.log.ErrorContext(ctx, "seed: rescale-fixtures failed, aborting", "err", err)
		}
	}()
	data, err := parseDevData()
	if err != nil {
		return fmt.Errorf("parse dev seed data: %w", err)
	}
	videosByKey := make(map[string]string, len(data.Videos))
	for _, v := range data.Videos {
		videosByKey[v.S3Key] = v.LocalPath
	}

	fixed := 0
	for _, c := range data.Courses {
		if c.Title == mlCourseTitle {
			continue // real-analysis course — leave its data (and FDB) alone
		}
		org, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.Organization, error) {
			return q.GetOrganizationBySlug(ctx, c.OrgSlug)
		})
		if err != nil {
			return fmt.Errorf("lookup org %s: %w", c.OrgSlug, err)
		}
		dbCourses, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.Course, error) {
			return q.ListCoursesByOrg(ctx, gen.ListCoursesByOrgParams{OrganizationID: org.ID, Limit: 1000, Offset: 0})
		})
		if err != nil {
			return fmt.Errorf("list courses for org %s: %w", c.OrgSlug, err)
		}
		var course gen.Course
		for _, dc := range dbCourses {
			if dc.Title == c.Title {
				course = dc
				break
			}
		}
		if !course.ID.Valid {
			continue
		}
		dbModules, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.CourseModule, error) {
			return q.ListCourseModules(ctx, gen.ListCourseModulesParams{CourseID: course.ID, Limit: 1000, Offset: 0})
		})
		if err != nil {
			return fmt.Errorf("list modules for course %q: %w", c.Title, err)
		}
		for _, m := range c.Modules {
			var moduleID pgtype.UUID
			for _, dm := range dbModules {
				if dm.Title == m.Title {
					moduleID = dm.ID
					break
				}
			}
			if !moduleID.Valid {
				continue
			}
			dbLessons, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.Lesson, error) {
				return q.ListLessons(ctx, gen.ListLessonsParams{ModuleID: moduleID, Limit: 1000, Offset: 0})
			})
			if err != nil {
				return fmt.Errorf("list lessons for module %q: %w", m.Title, err)
			}
			for _, l := range m.Lessons {
				if l.Analysis == nil {
					continue
				}
				var lessonID pgtype.UUID
				for _, dl := range dbLessons {
					if dl.Title == l.Title {
						lessonID = dl.ID
						break
					}
				}
				if !lessonID.Valid {
					continue
				}
				var videoDurSecs float64
				if l.VideoKey != "" {
					if lp, ok := videosByKey[l.VideoKey]; ok {
						videoDurSecs = probeVideoDurationSecs(ctx, lp)
					}
					durationSecs := l.DurationSecs
					if videoDurSecs > 0 {
						durationSecs = int32(math.Round(videoDurSecs))
					}
					if _, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) (gen.Lesson, error) {
						return q.UpdateLessonVideo(ctx, gen.UpdateLessonVideoParams{
							ID:              lessonID,
							VideoStorageKey: pgtype.Text{String: l.VideoKey, Valid: true},
							DurationSeconds: pgtype.Int4{Int32: durationSecs, Valid: true},
						})
					}); err != nil {
						// A DB write failure here is genuine (not an external dep) and it
						// leaves the fixture fit working off a stale/missing duration →
						// STOP, matching the two sibling UpdateLessonVideo call sites.
						return fmt.Errorf("rescale: set video/duration for lesson %q: %w", l.Title, err)
					}
				}
				if err := s.seedLessonAnalysis(ctx, lessonID, course.OwnerID, l.Analysis, videoDurSecs); err != nil {
					return fmt.Errorf("rescale analysis for lesson %q: %w", l.Title, err)
				}
				fixed++
			}
		}
		s.log.InfoContext(ctx, "rescale: course re-fitted", "org", c.OrgSlug, "title", c.Title)
	}
	// Re-fitting re-creates interactions (via resetLessonAnalysis), which cascade-deletes
	// lesson_attempt_responses (FK ON DELETE CASCADE). Re-submit the explicit attempts so
	// those responses are restored against the new interactions — otherwise demo-course
	// analytics would be silently emptied by a repair that's meant to be non-destructive.
	if err := s.seedExplicitAttempts(ctx, data.Attempts); err != nil {
		return fmt.Errorf("rescale: re-seed attempts: %w", err)
	}
	s.log.InfoContext(ctx, "rescale: complete", "lessons_refitted", fixed)
	return nil
}

func (s *SeederSvc) seedLessonAnalysis(ctx context.Context, lessonID pgtype.UUID, createdBy pgtype.UUID, a *devAnalysisSpec, videoDurSecs float64) error {
	// The dev seeder produces analyzed lessons by running the REAL transcript
	// pipeline (transcript.Service.RunExtract + RunChunk) with the AI boundaries
	// (STT + chunking) backed by golden fixtures built from the curated JSON. This
	// yields the same FDB(transcript+segments) + Postgres(chunks) a real
	// Whisper/Gemini run would — no dual-store divergence, deterministic, no network.

	// A coherent analysis requires a transcript. Curated chunks/questions with no
	// transcript can never form a consistent lesson, so fail loudly.
	if a.Transcript == "" {
		if len(a.Questions) > 0 || len(a.Chunks) > 0 {
			return fmt.Errorf("lesson %s has chunks/questions but no transcript", lessonID.String())
		}
		return nil // nothing to analyze
	}

	// Idempotency: clear any prior analysis so a re-run (e.g. `seed rescale-fixtures`)
	// rewrites cleanly instead of duplicating. Interactions are deleted explicitly —
	// their chunk_id FK is ON DELETE SET NULL, so they do NOT cascade when chunks go —
	// then chunks + tasks; RunExtract below overwrites the FDB transcript/segments.
	if err := s.resetLessonAnalysis(ctx, lessonID); err != nil {
		return fmt.Errorf("reset prior analysis for lesson %s: %w", lessonID.String(), err)
	}

	// Resolve chunk boundaries. Curated chunks win; if the lesson has questions but
	// no chunks (a real inconsistency in some seed JSON), derive a single chunk over
	// the whole timeline so every question still attaches to a real chunk.
	chunks := append([]devChunkSpec(nil), a.Chunks...)
	questions := append([]devQuestionSpec(nil), a.Questions...)
	totalDur := 0.0
	for _, c := range chunks {
		if c.EndSeconds > totalDur {
			totalDur = c.EndSeconds
		}
	}
	if len(chunks) == 0 {
		for _, q := range questions {
			if q.StartSeconds+1 > totalDur {
				totalDur = q.StartSeconds + 1
			}
		}
		if totalDur <= 0 {
			totalDur = 60
		}
		chunks = []devChunkSpec{{StartSeconds: 0, EndSeconds: totalDur, Summary: "Toàn bài"}}
	}

	// Fit the golden-fixture timeline to the REAL mapped video duration. The fixture
	// chunk/interaction timestamps are authored for the original (longer) lecture, so
	// on a shorter demo clip they'd otherwise run past the end of the video — the
	// checkpoint markers beyond the video duration are silently dropped by the player,
	// so exercises go missing / sit at the wrong spot. Scaling everything by the same
	// factor keeps each interaction at its chunk boundary, just proportionally placed
	// inside the actual video. span = furthest fixture timestamp (chunk end or
	// question start); only shrink (never stretch) so already-fitting data is untouched.
	span := totalDur
	for _, q := range questions {
		if q.StartSeconds > span {
			span = q.StartSeconds
		}
	}

	// Chunks in ascending order first: RunChunk assigns order_index in slice order,
	// dbChunks come back in that order, so chunks[j] ↔ dbChunks[j].
	sort.SliceStable(chunks, func(i, j int) bool {
		return chunks[i].StartSeconds < chunks[j].StartSeconds
	})

	// Attribute each authored question to a chunk INDEX using the ORIGINAL (unscaled,
	// integer) timestamps. Doing it BEFORE scaling — not against the float32 DB chunk
	// bounds afterwards — avoids boundary misrouting: authored questions frequently sit
	// exactly on a chunk edge, where float32/float64 rounding otherwise sends them to
	// the wrong chunk. The interaction is placed at THIS chunk's end (below).
	qChunkIdx := make([]int, len(questions))
	for i, q := range questions {
		idx := 0
		for j, c := range chunks {
			if q.StartSeconds >= c.StartSeconds && q.StartSeconds < c.EndSeconds {
				idx = j
				break
			}
			if q.StartSeconds >= c.StartSeconds {
				idx = j // last chunk that has started by this timestamp
			}
		}
		qChunkIdx[i] = idx
	}

	// Fit the golden-fixture timeline to the REAL mapped video duration: scale chunk
	// bounds + totalDur so nothing runs past the (shorter) demo clip. Question
	// timestamps are NOT scaled — each is re-placed at its chunk's end below, exactly
	// like the real generation pipeline (CheckpointSecondsForChunk).
	if videoDurSecs > 0 && span > videoDurSecs+0.5 {
		k := videoDurSecs / span
		for i := range chunks {
			chunks[i].StartSeconds *= k
			chunks[i].EndSeconds *= k
		}
		totalDur *= k
		s.log.InfoContext(ctx, "seed: fitted fixture timeline to video duration",
			"lesson", lessonID.String(), "fixture_span", math.Round(span), "video_dur", math.Round(videoDurSecs))
	}

	chunkJSON, err := buildSeedChunkJSON(chunks)
	if err != nil {
		return fmt.Errorf("build chunk fixture for lesson %s: %w", lessonID.String(), err)
	}

	// Run the real transcribe + chunk stages with golden fixtures. RunExtract writes
	// transcript+segments to FDB and clears stale downstream data; RunChunk inserts
	// chunks and writes per-chunk FDB transcripts.
	ts := s.newSeedTranscriptService(a.Transcript, totalDur, chunkJSON)
	if err := ts.RunExtract(ctx, lessonID, "seed", "vi", noopProgress); err != nil {
		return fmt.Errorf("RunExtract lesson %s: %w", lessonID.String(), err)
	}
	if err := ts.RunChunk(ctx, lessonID, noopProgress); err != nil {
		return fmt.Errorf("RunChunk lesson %s: %w", lessonID.String(), err)
	}

	// Load the chunks RunChunk just created so curated questions attach to real
	// chunk IDs (chunk_id is therefore never NULL).
	dbChunks, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.LessonTranscriptChunk, error) {
		return q.ListLessonTranscriptChunks(ctx, gen.ListLessonTranscriptChunksParams{LessonID: lessonID, Limit: 5000, Offset: 0})
	})
	if err != nil {
		return fmt.Errorf("list chunks lesson %s: %w", lessonID.String(), err)
	}
	if len(dbChunks) == 0 {
		return fmt.Errorf("lesson %s produced no chunks", lessonID.String())
	}
	sort.SliceStable(dbChunks, func(i, j int) bool {
		return dbChunks[i].StartSeconds < dbChunks[j].StartSeconds
	})

	// Insert curated (authored) questions THROUGH the same business path a teacher
	// uses to add a question by hand — InteractionsSvc.CreateManualInteraction — so the
	// row is consistent with production by construction (no raw INSERT). We act as the
	// course owner, who CreateCourse auto-enrols as course TEACHER, satisfying the
	// service's teacher-role guard. The authored start_seconds only decides WHICH chunk
	// the question belongs to (we pass chunk_id explicitly); its checkpoint fires at
	// that chunk's END — exactly where the real generation pipeline places questions
	// (CheckpointSecondsForChunk) — which is why seeded questions show at chunk-end.
	interactionsSvc, err := do.Invoke[*interactions.InteractionsSvc](internal.Injector)
	if err != nil {
		return fmt.Errorf("invoke InteractionsSvc: %w", err)
	}
	ownerCtx := authz.ContextWithClaims(ctx, &jwtv1.JWTClaims{
		Sub:    uuidStr(createdBy),
		Role:   richterv1.UserRole_USER_ROLE_NORMAL,
		Status: richterv1.UserStatus_USER_STATUS_ACTIVE,
	})
	for i, qspec := range questions {
		idx := qChunkIdx[i]
		if idx >= len(dbChunks) {
			idx = len(dbChunks) - 1
		}
		chunk := dbChunks[idx]
		opts := make([]*richterv1.McqOption, 0, len(qspec.Options))
		for _, o := range qspec.Options {
			opts = append(opts, &richterv1.McqOption{Text: o})
		}
		if _, err := interactionsSvc.CreateManualInteraction(ownerCtx, &richterv1.CreateManualInteractionRequest{
			LessonId:     uuidStr(lessonID),
			Prompt:       qspec.QuestionText,
			Explanation:  qspec.Explanation,
			StartSeconds: generation.CheckpointSecondsForChunk(chunk),
			ChunkId:      uuidStr(chunk.ID),
			Config: &richterv1.CreateManualInteractionRequest_Mcq{
				Mcq: &richterv1.McqConfig{
					Options:       opts,
					CorrectAnswer: qspec.CorrectAnswer,
				},
			},
		}); err != nil {
			return fmt.Errorf("create interaction %d for lesson %s: %w", i, lessonID.String(), err)
		}
	}

	// Coherent succeeded task set (transcribe+chunk+quiz_gen) so GetLessonAnalysis
	// derives DONE and loads the FDB transcript (deriveAnalysisFromTasks +
	// canLoadTranscript both key off these task rows).
	for _, taskType := range []string{"transcribe", "chunk", "quiz_gen"} {
		taskID, err := uuid.NewV7()
		if err != nil {
			return fmt.Errorf("generate task ID: %w", err)
		}
		tid := pgtype.UUID{Bytes: [16]byte(taskID), Valid: true}
		if err := db.WithConnectionExec(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) error {
			_, err := q.InsertSeededTask(ctx, gen.InsertSeededTaskParams{
				ID:           tid,
				LessonID:     lessonID,
				TaskType:     taskType,
				Status:       gen.TaskStatusSucceeded,
				InputPayload: nil,
				CreatedBy:    createdBy,
			})
			return err
		}); err != nil {
			return fmt.Errorf("insert %s task: %w", taskType, err)
		}
	}

	return nil
}

func (s *SeederSvc) seedLessonRealAnalysis(ctx context.Context, lessonID pgtype.UUID, createdBy pgtype.UUID, l devLessonSpec) error {
	// 1. Idempotency Check: if chunks and interactions already exist, skip.
	dbChunks, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.LessonTranscriptChunk, error) {
		return q.ListLessonTranscriptChunks(ctx, gen.ListLessonTranscriptChunksParams{
			LessonID: lessonID,
			Limit:    1,
			Offset:   0,
		})
	})
	if err == nil && len(dbChunks) > 0 {
		dbInteractions, intErr := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.LessonInteraction, error) {
			return q.ListLessonInteractions(ctx, gen.ListLessonInteractionsParams{
				LessonID: lessonID,
				Limit:    1,
				Offset:   0,
			})
		})
		// Only skip when the PREVIOUS run FULLY completed — proven by the terminal
		// `quiz_gen` succeeded task row (inserted last, after the interaction assert).
		// A run aborted mid-loop (some chunks analyzed, some not) has no such row, so
		// it must re-process rather than be wrongly treated as complete.
		tasks, taskErr := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.Task, error) {
			return q.ListTasksByLesson(ctx, gen.ListTasksByLessonParams{LessonID: lessonID, Limit: 100, Offset: 0})
		})
		fullyDone := false
		if taskErr == nil {
			for _, t := range tasks {
				if t.TaskType == "quiz_gen" && t.Status == gen.TaskStatusSucceeded {
					fullyDone = true
					break
				}
			}
		}
		if intErr == nil && len(dbInteractions) > 0 && fullyDone {
			s.log.InfoContext(ctx, "seed: lesson already has complete real analysis, skipping pipeline run", "lesson_id", lessonID.String(), "title", l.Title)
			return nil
		}
	}

	// 2. Pre-upload video if not already present in S3 bucket.
	if _, err := s.s3client.StatObject(ctx, s.s3cfg.Bucket, l.VideoKey, minio.StatObjectOptions{}); err != nil {
		localVideoPath := filepath.Join(mlVideoDir, filepath.Base(l.VideoKey))
		s.log.InfoContext(ctx, "seed: uploading video to S3 before real analysis", "key", l.VideoKey, "file", localVideoPath)
		if err := s.uploadFromFile(ctx, l.VideoKey, localVideoPath); err != nil {
			// Wrap as errSeedVideoUnavailable so the caller falls back to golden
			// fixtures (external data missing) rather than aborting the seed.
			return fmt.Errorf("%w: pre-upload %q: %v", errSeedVideoUnavailable, localVideoPath, err)
		}
		s.log.InfoContext(ctx, "seed: video uploaded successfully", "key", l.VideoKey)
	}

	// 3. Clear any partial analysis / chunks / tasks to ensure a clean start
	if err := db.WithConnectionExec(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) error {
		return q.DeleteLessonTranscriptChunks(ctx, lessonID)
	}); err != nil {
		return fmt.Errorf("delete chunks: %w", err)
	}
	if err := db.WithConnectionExec(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) error {
		return q.DeleteTasksForLesson(ctx, lessonID)
	}); err != nil {
		return fmt.Errorf("delete tasks: %w", err)
	}

	// 4. Retrieve *ai.AISvc
	aiSvc, err := do.Invoke[*ai.AISvc](internal.Injector)
	if err != nil {
		return fmt.Errorf("invoke AISvc: %w", err)
	}

	// 5. Run transcription
	s.log.InfoContext(ctx, "seed: transcribing video...", "lesson_id", lessonID.String(), "key", l.VideoKey)
	err = aiSvc.Transcript().RunExtract(ctx, lessonID, l.VideoKey, "vi", func(step richterv1.AnalysisProgressStep, msg string) error {
		s.log.InfoContext(ctx, "seed pipeline [Extract]", "step", step.String(), "msg", msg)
		return nil
	})
	if err != nil {
		return fmt.Errorf("RunExtract failed: %w", err)
	}

	// 6. Run chunking
	s.log.InfoContext(ctx, "seed: chunking transcript...", "lesson_id", lessonID.String())
	err = aiSvc.Transcript().RunChunk(ctx, lessonID, func(step richterv1.AnalysisProgressStep, msg string) error {
		s.log.InfoContext(ctx, "seed pipeline [Chunk]", "step", step.String(), "msg", msg)
		return nil
	})
	if err != nil {
		return fmt.Errorf("RunChunk failed: %w", err)
	}

	// 7. Run quiz generation (interactions)
	s.log.InfoContext(ctx, "seed: generating interactions...", "lesson_id", lessonID.String())
	req := &richterv1.GenerateInteractionsRequest{
		LessonId:         uuid.UUID(lessonID.Bytes).String(),
		InteractionKinds: []richterv1.InteractionKind{
			richterv1.InteractionKind_INTERACTION_KIND_SINGLE_CHOICE,
			richterv1.InteractionKind_INTERACTION_KIND_FILL_BLANK,
			richterv1.InteractionKind_INTERACTION_KIND_LISTENING,
			richterv1.InteractionKind_INTERACTION_KIND_READING,
			richterv1.InteractionKind_INTERACTION_KIND_WRITING,
		},
		CountPerChunk:    1, // At least 1 exercise per chunk
		Strategy:         richterv1.GenerationStrategy_GENERATION_STRATEGY_AI_CHOOSE,
		Difficulty:       "medium",
		ForceRegenerate:  true,
	}
	err = aiSvc.Generation().Run(ctx, lessonID, req, func(step richterv1.GenerateInteractionsStep, msg string, chunkIndex, totalChunks int32) error {
		s.log.InfoContext(ctx, "seed pipeline [Gen]", "step", step.String(), "msg", msg, "chunkIndex", chunkIndex, "totalChunks", totalChunks)
		return nil
	})
	if err != nil {
		return fmt.Errorf("Generation failed: %w", err)
	}

	// Generation().Run returns nil even if EVERY chunk's Gemini call failed (per-chunk
	// errors are logged + skipped inside Run). Guard against silently marking the lesson
	// "done" with zero exercises: require at least one interaction, else abort so the
	// seed fails loudly (genuine pipeline failure, NOT an external-dep fallback case).
	genInteractions, err := db.WithConnection(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) ([]gen.LessonInteraction, error) {
		return q.ListLessonInteractions(ctx, gen.ListLessonInteractionsParams{LessonID: lessonID, Limit: 1, Offset: 0})
	})
	if err != nil {
		return fmt.Errorf("verify generated interactions for lesson %s: %w", lessonID.String(), err)
	}
	if len(genInteractions) == 0 {
		return fmt.Errorf("real analysis for lesson %s produced 0 interactions (Gemini generation likely failed for every chunk — quota/API error)", lessonID.String())
	}

	// 8. Insert the task rows as succeeded
	for _, taskType := range []string{"transcribe", "chunk", "quiz_gen"} {
		taskID, err := uuid.NewV7()
		if err != nil {
			return fmt.Errorf("generate task ID: %w", err)
		}
		tid := pgtype.UUID{Bytes: [16]byte(taskID), Valid: true}
		if err := db.WithConnectionExec(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) error {
			_, err := q.InsertSeededTask(ctx, gen.InsertSeededTaskParams{
				ID:           tid,
				LessonID:     lessonID,
				TaskType:     taskType,
				Status:       gen.TaskStatusSucceeded,
				InputPayload: nil,
				CreatedBy:    createdBy,
			})
			return err
		}); err != nil {
			return fmt.Errorf("insert %s task: %w", taskType, err)
		}
	}

	// 9. Update lesson analysis status to done
	if err := db.WithConnectionExec(s.pg, ctx, func(q *gen.Queries, _ *pgxpool.Conn) error {
		_, err := q.UpsertLessonAnalysisStatus(ctx, gen.UpsertLessonAnalysisStatusParams{
			LessonID: lessonID,
			Status:   gen.LessonAnalysisStatusDone,
			ErrorMsg: pgtype.Text{},
		})
		return err
	}); err != nil {
		return fmt.Errorf("upsert analysis status: %w", err)
	}

	s.log.InfoContext(ctx, "seed: real video analysis pipeline completed successfully", "lesson", l.Title)
	return nil
}
