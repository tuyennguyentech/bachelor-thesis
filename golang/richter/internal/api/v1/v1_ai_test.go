//go:build integ

package v1

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/buf/gen/richter/v1/richterv1connect"
	"example.com/richter/cfg"
	"example.com/richter/internal"
	"example.com/richter/internal/db"
	"example.com/richter/internal/kv"
	"example.com/sql/gen"
	"github.com/apple/foundationdb/bindings/go/src/fdb/tuple"
	"github.com/brianvoe/gofakeit/v7"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	"github.com/samber/do/v2"
)

// ── shared setup ──────────────────────────────────────────────────────────────

type aiTestEnv struct {
	url           string
	orgID         string
	lessonID      string
	moduleID      string
	courseID      string
	ownerID       string
	ownerToken    string
	teacherToken  string
	studentToken  string
	student2Token string
	nonMemberToken string

	aiAnon      richterv1connect.AIServiceClient
	aiOwner     richterv1connect.AIServiceClient
	aiTeacher   richterv1connect.AIServiceClient
	aiStudent   richterv1connect.AIServiceClient
	aiStudent2  richterv1connect.AIServiceClient
	aiNonMember richterv1connect.AIServiceClient

	adminLessons richterv1connect.LessonServiceClient
	adminUsers   richterv1connect.UserServiceClient
}

func setupAIEnv(t *testing.T) aiTestEnv {
	t.Helper()
	url := newV1Server(t)
	ctx := context.Background()
	adminToken := getAdminToken(t, url)

	adminUsers := richterv1connect.NewUserServiceClient(httpClientWithToken(adminToken), url)
	adminMembers := richterv1connect.NewOrganizationMemberServiceClient(httpClientWithToken(adminToken), url)
	adminCourses := richterv1connect.NewCourseServiceClient(httpClientWithToken(adminToken), url)
	adminModules := richterv1connect.NewCourseModuleServiceClient(httpClientWithToken(adminToken), url)
	adminLessons := richterv1connect.NewLessonServiceClient(httpClientWithToken(adminToken), url)

	ownerEmail, ownerPass, ownerID := createActiveUser(t, adminUsers)
	ownerToken := getUserToken(t, url, ownerEmail, ownerPass)

	teacherEmail, teacherPass, teacherID := createActiveUser(t, adminUsers)
	teacherToken := getUserToken(t, url, teacherEmail, teacherPass)

	studentEmail, studentPass, studentID := createActiveUser(t, adminUsers)
	studentToken := getUserToken(t, url, studentEmail, studentPass)

	student2Email, student2Pass, student2ID := createActiveUser(t, adminUsers)
	student2Token := getUserToken(t, url, student2Email, student2Pass)

	nonMemberEmail, nonMemberPass, _ := createActiveUser(t, adminUsers)
	nonMemberToken := getUserToken(t, url, nonMemberEmail, nonMemberPass)

	orgRes, err := richterv1connect.NewOrganizationServiceClient(httpClientWithToken(ownerToken), url).
		CreateOrganization(ctx, &richterv1.CreateOrganizationRequest{
			CreatedBy: ownerID, Name: gofakeit.Company(), Slug: testSlug(),
		})
	if err != nil {
		t.Fatalf("setup: create org: %v", err)
	}
	orgID := orgRes.Organization.Id

	for _, m := range []struct {
		id   string
		role richterv1.OrganizationRole
	}{
		{teacherID, richterv1.OrganizationRole_ORGANIZATION_ROLE_TEACHER},
		{studentID, richterv1.OrganizationRole_ORGANIZATION_ROLE_STUDENT},
		{student2ID, richterv1.OrganizationRole_ORGANIZATION_ROLE_STUDENT},
	} {
		if _, err := adminMembers.AddOrganizationMember(ctx, &richterv1.AddOrganizationMemberRequest{
			OrganizationId: orgID, UserId: m.id,
			Role: m.role, Status: richterv1.MemberStatus_MEMBER_STATUS_ACTIVE,
		}); err != nil {
			t.Fatalf("setup: add member: %v", err)
		}
	}

	courseRes, err := adminCourses.CreateCourse(ctx, &richterv1.CreateCourseRequest{
		OrganizationId: orgID, OwnerId: ownerID, Title: gofakeit.JobTitle(),
	})
	if err != nil {
		t.Fatalf("setup: create course: %v", err)
	}
	modRes, err := adminModules.CreateCourseModule(ctx, &richterv1.CreateCourseModuleRequest{
		CourseId: courseRes.Course.Id, Title: gofakeit.JobTitle(), OrderIndex: 0,
	})
	if err != nil {
		t.Fatalf("setup: create module: %v", err)
	}
	lessonRes, err := adminLessons.CreateLesson(ctx, &richterv1.CreateLessonRequest{
		ModuleId: modRes.Module.Id, Title: gofakeit.JobTitle(), OrderIndex: 0,
	})
	if err != nil {
		t.Fatalf("setup: create lesson: %v", err)
	}

	return aiTestEnv{
		url:           url,
		orgID:         orgID,
		lessonID:      lessonRes.Lesson.Id,
		moduleID:      modRes.Module.Id,
		courseID:      courseRes.Course.Id,
		ownerID:       ownerID,
		ownerToken:    ownerToken,
		teacherToken:  teacherToken,
		studentToken:  studentToken,
		student2Token: student2Token,
		nonMemberToken: nonMemberToken,

		aiAnon:      richterv1connect.NewAIServiceClient(http.DefaultClient, url),
		aiOwner:     richterv1connect.NewAIServiceClient(httpClientWithToken(ownerToken), url),
		aiTeacher:   richterv1connect.NewAIServiceClient(httpClientWithToken(teacherToken), url),
		aiStudent:   richterv1connect.NewAIServiceClient(httpClientWithToken(studentToken), url),
		aiStudent2:  richterv1connect.NewAIServiceClient(httpClientWithToken(student2Token), url),
		aiNonMember: richterv1connect.NewAIServiceClient(httpClientWithToken(nonMemberToken), url),

		adminLessons: adminLessons,
		adminUsers:   adminUsers,
	}
}

// insertTestChunk inserts a transcript chunk in PG and writes its transcript to FDB.
func insertTestChunk(t *testing.T, lessonID string, orderIdx int32, transcript string) gen.LessonTranscriptChunk {
	t.Helper()
	pool, err := do.Invoke[*db.PostgresSvc](internal.Injector)
	if err != nil {
		t.Fatalf("get db: %v", err)
	}
	var lid pgtype.UUID
	if err := lid.Scan(lessonID); err != nil {
		t.Fatalf("parse lessonID: %v", err)
	}
	chunk, err := db.WithConnection(pool, context.Background(), func(q *gen.Queries, _ *pgxpool.Conn) (gen.LessonTranscriptChunk, error) {
		return q.InsertLessonTranscriptChunk(context.Background(), gen.InsertLessonTranscriptChunkParams{
			LessonID:            lid,
			OrderIndex:          orderIdx,
			StartSeconds:        float64(orderIdx * 60),
			EndSeconds:          float64(orderIdx*60 + 60),
			Summary:             gofakeit.Sentence(3),
			QuestionCountConfig: 1,
		})
	})
	if err != nil {
		t.Fatalf("insert chunk: %v", err)
	}
	if transcript != "" {
		kvSvc, err := do.Invoke[*kv.KVSvc](internal.Injector)
		if err != nil {
			t.Fatalf("invoke KVSvc: %v", err)
		}
		if err := kvSvc.Set("chunk", tuple.Tuple{chunk.ID.String(), "transcript"}, []byte(transcript)); err != nil {
			t.Fatalf("FDB Set chunk transcript: %v", err)
		}
	}
	return chunk
}

// insertTestAnalysis inserts a lesson analysis row in the DB.
func insertTestAnalysis(t *testing.T, lessonID string, status gen.LessonAnalysisStatus) gen.LessonAnalysis {
	t.Helper()
	pool, err := do.Invoke[*db.PostgresSvc](internal.Injector)
	if err != nil {
		t.Fatalf("get db: %v", err)
	}
	var lid pgtype.UUID
	if err := lid.Scan(lessonID); err != nil {
		t.Fatalf("parse lessonID: %v", err)
	}
	analysis, err := db.WithConnection(pool, context.Background(), func(q *gen.Queries, _ *pgxpool.Conn) (gen.LessonAnalysis, error) {
		return q.UpsertLessonAnalysisStatus(context.Background(), gen.UpsertLessonAnalysisStatusParams{
			LessonID: lid,
			Status:   status,
			ErrorMsg: pgtype.Text{},
		})
	})
	if err != nil {
		t.Fatalf("insert analysis: %v", err)
	}
	return analysis
}

// ── TestAIAuthz ───────────────────────────────────────────────────────────────

func TestAIAuthz(t *testing.T) {
	e := setupAIEnv(t)
	ctx := context.Background()

	// --- GetLessonAnalysis ---
	t.Run("GetLessonAnalysis", func(t *testing.T) {
		req := &richterv1.GetLessonAnalysisRequest{LessonId: e.lessonID}
		t.Run("Anon/Unauthenticated", func(t *testing.T) {
			assertCode(t, func() error { _, err := e.aiAnon.GetLessonAnalysis(ctx, req); return err }(), connect.CodeUnauthenticated)
		})
		t.Run("NonMember/PermissionDenied", func(t *testing.T) {
			assertCode(t, func() error { _, err := e.aiNonMember.GetLessonAnalysis(ctx, req); return err }(), connect.CodePermissionDenied)
		})
		t.Run("Student/OK", func(t *testing.T) {
			if _, err := e.aiStudent.GetLessonAnalysis(ctx, req); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
		t.Run("Teacher/OK", func(t *testing.T) {
			if _, err := e.aiTeacher.GetLessonAnalysis(ctx, req); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
	})

	// --- ExtractTranscriptStream ---
	t.Run("ExtractTranscriptStream", func(t *testing.T) {
		req := &richterv1.ExtractTranscriptRequest{LessonId: e.lessonID}

		streamErr := func(s interface {
			Receive() bool
			Err() error
		}, callErr error) error {
			if callErr != nil {
				return callErr
			}
			s.Receive()
			return s.Err()
		}

		t.Run("Anon/Unauthenticated", func(t *testing.T) {
			s, err := e.aiAnon.ExtractTranscriptStream(ctx, req)
			assertCode(t, streamErr(s, err), connect.CodeUnauthenticated)
		})
		t.Run("NonMember/PermissionDenied", func(t *testing.T) {
			s, err := e.aiNonMember.ExtractTranscriptStream(ctx, req)
			assertCode(t, streamErr(s, err), connect.CodePermissionDenied)
		})
		t.Run("Student/PermissionDenied", func(t *testing.T) {
			s, err := e.aiStudent.ExtractTranscriptStream(ctx, req)
			assertCode(t, streamErr(s, err), connect.CodePermissionDenied)
		})
		t.Run("Teacher/NoVideo/FailedPrecondition", func(t *testing.T) {
			s, err := e.aiTeacher.ExtractTranscriptStream(ctx, req)
			assertCode(t, streamErr(s, err), connect.CodeFailedPrecondition)
		})
	})

	// --- GenerateQuestionsStream ---
	t.Run("GenerateQuestionsStream", func(t *testing.T) {
		req := &richterv1.GenerateQuestionsRequest{LessonId: e.lessonID}

		streamErr := func(s interface {
			Receive() bool
			Err() error
		}, callErr error) error {
			if callErr != nil {
				return callErr
			}
			s.Receive()
			return s.Err()
		}

		t.Run("Anon/Unauthenticated", func(t *testing.T) {
			s, err := e.aiAnon.GenerateQuestionsStream(ctx, req)
			assertCode(t, streamErr(s, err), connect.CodeUnauthenticated)
		})
		t.Run("NonMember/PermissionDenied", func(t *testing.T) {
			s, err := e.aiNonMember.GenerateQuestionsStream(ctx, req)
			assertCode(t, streamErr(s, err), connect.CodePermissionDenied)
		})
		t.Run("Student/PermissionDenied", func(t *testing.T) {
			s, err := e.aiStudent.GenerateQuestionsStream(ctx, req)
			assertCode(t, streamErr(s, err), connect.CodePermissionDenied)
		})
		// Teacher authorized, but no chunks → FailedPrecondition
		t.Run("Teacher/NoChunks/FailedPrecondition", func(t *testing.T) {
			s, err := e.aiTeacher.GenerateQuestionsStream(ctx, req)
			assertCode(t, streamErr(s, err), connect.CodeFailedPrecondition)
		})
	})

	// --- ListLessonTranscriptChunks ---
	t.Run("ListLessonTranscriptChunks", func(t *testing.T) {
		req := &richterv1.ListLessonTranscriptChunksRequest{LessonId: e.lessonID}
		t.Run("Anon/Unauthenticated", func(t *testing.T) {
			assertCode(t, func() error { _, err := e.aiAnon.ListLessonTranscriptChunks(ctx, req); return err }(), connect.CodeUnauthenticated)
		})
		t.Run("NonMember/PermissionDenied", func(t *testing.T) {
			assertCode(t, func() error { _, err := e.aiNonMember.ListLessonTranscriptChunks(ctx, req); return err }(), connect.CodePermissionDenied)
		})
		t.Run("Student/OK", func(t *testing.T) {
			if _, err := e.aiStudent.ListLessonTranscriptChunks(ctx, req); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
		t.Run("Teacher/OK", func(t *testing.T) {
			if _, err := e.aiTeacher.ListLessonTranscriptChunks(ctx, req); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
	})

	// --- UpdateWatchProgress ---
	t.Run("UpdateWatchProgress", func(t *testing.T) {
		req := &richterv1.UpdateWatchProgressRequest{LessonId: e.lessonID, PositionSeconds: 30}
		t.Run("Anon/Unauthenticated", func(t *testing.T) {
			assertCode(t, func() error { _, err := e.aiAnon.UpdateWatchProgress(ctx, req); return err }(), connect.CodeUnauthenticated)
		})
		t.Run("NonMember/PermissionDenied", func(t *testing.T) {
			assertCode(t, func() error { _, err := e.aiNonMember.UpdateWatchProgress(ctx, req); return err }(), connect.CodePermissionDenied)
		})
		t.Run("Student/OK", func(t *testing.T) {
			if _, err := e.aiStudent.UpdateWatchProgress(ctx, req); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
		t.Run("Teacher/OK", func(t *testing.T) {
			if _, err := e.aiTeacher.UpdateWatchProgress(ctx, req); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
	})

	// --- GetWatchProgress ---
	t.Run("GetWatchProgress", func(t *testing.T) {
		req := &richterv1.GetWatchProgressRequest{LessonId: e.lessonID}
		t.Run("Anon/Unauthenticated", func(t *testing.T) {
			assertCode(t, func() error { _, err := e.aiAnon.GetWatchProgress(ctx, req); return err }(), connect.CodeUnauthenticated)
		})
		t.Run("NonMember/PermissionDenied", func(t *testing.T) {
			assertCode(t, func() error { _, err := e.aiNonMember.GetWatchProgress(ctx, req); return err }(), connect.CodePermissionDenied)
		})
		t.Run("Student/OK", func(t *testing.T) {
			if _, err := e.aiStudent.GetWatchProgress(ctx, req); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
		t.Run("Teacher/OK", func(t *testing.T) {
			if _, err := e.aiTeacher.GetWatchProgress(ctx, req); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
	})

	// --- UpdateTranscriptSegment ---
	t.Run("UpdateTranscriptSegment", func(t *testing.T) {
		req := &richterv1.UpdateTranscriptSegmentRequest{
			LessonId: e.lessonID, SegmentIndex: 0, Text: "updated text",
		}
		t.Run("Anon/Unauthenticated", func(t *testing.T) {
			assertCode(t, func() error { _, err := e.aiAnon.UpdateTranscriptSegment(ctx, req); return err }(), connect.CodeUnauthenticated)
		})
		t.Run("NonMember/PermissionDenied", func(t *testing.T) {
			assertCode(t, func() error { _, err := e.aiNonMember.UpdateTranscriptSegment(ctx, req); return err }(), connect.CodePermissionDenied)
		})
		t.Run("Student/PermissionDenied", func(t *testing.T) {
			assertCode(t, func() error { _, err := e.aiStudent.UpdateTranscriptSegment(ctx, req); return err }(), connect.CodePermissionDenied)
		})
		// Teacher is authorized — fails with NotFound because no segments exist in FDB yet.
		t.Run("Teacher/NoSegments/NotFound", func(t *testing.T) {
			assertCode(t, func() error { _, err := e.aiTeacher.UpdateTranscriptSegment(ctx, req); return err }(), connect.CodeNotFound)
		})
	})

	// --- ChunkTranscriptStream ---
	t.Run("ChunkTranscriptStream", func(t *testing.T) {
		req := &richterv1.ChunkTranscriptRequest{LessonId: e.lessonID}

		streamErr := func(s interface {
			Receive() bool
			Err() error
		}, callErr error) error {
			if callErr != nil {
				return callErr
			}
			s.Receive()
			return s.Err()
		}

		t.Run("Anon/Unauthenticated", func(t *testing.T) {
			s, err := e.aiAnon.ChunkTranscriptStream(ctx, req)
			assertCode(t, streamErr(s, err), connect.CodeUnauthenticated)
		})
		t.Run("NonMember/PermissionDenied", func(t *testing.T) {
			s, err := e.aiNonMember.ChunkTranscriptStream(ctx, req)
			assertCode(t, streamErr(s, err), connect.CodePermissionDenied)
		})
		t.Run("Student/PermissionDenied", func(t *testing.T) {
			s, err := e.aiStudent.ChunkTranscriptStream(ctx, req)
			assertCode(t, streamErr(s, err), connect.CodePermissionDenied)
		})
		// Teacher is authorized — fails with FailedPrecondition because no transcript in FDB.
		t.Run("Teacher/NoTranscript/FailedPrecondition", func(t *testing.T) {
			s, err := e.aiTeacher.ChunkTranscriptStream(ctx, req)
			assertCode(t, streamErr(s, err), connect.CodeFailedPrecondition)
		})
	})
}

// ── TestAIWatchProgress ───────────────────────────────────────────────────────

func TestAIWatchProgress(t *testing.T) {
	e := setupAIEnv(t)
	ctx := context.Background()

	t.Run("InitialProgress/Zero", func(t *testing.T) {
		res, err := e.aiStudent.GetWatchProgress(ctx, &richterv1.GetWatchProgressRequest{LessonId: e.lessonID})
		if err != nil {
			t.Fatalf("GetWatchProgress: %v", err)
		}
		if res.PositionSeconds != 0 {
			t.Errorf("expected 0 position before any save, got %v", res.PositionSeconds)
		}
	})

	t.Run("SaveAndRetrieve", func(t *testing.T) {
		const wantPos float32 = 123.5
		if _, err := e.aiStudent.UpdateWatchProgress(ctx, &richterv1.UpdateWatchProgressRequest{
			LessonId: e.lessonID, PositionSeconds: wantPos,
		}); err != nil {
			t.Fatalf("UpdateWatchProgress: %v", err)
		}
		res, err := e.aiStudent.GetWatchProgress(ctx, &richterv1.GetWatchProgressRequest{LessonId: e.lessonID})
		if err != nil {
			t.Fatalf("GetWatchProgress: %v", err)
		}
		if res.PositionSeconds != wantPos {
			t.Errorf("position: want %v, got %v", wantPos, res.PositionSeconds)
		}
	})

	t.Run("UpdateOverwrites", func(t *testing.T) {
		const newPos float32 = 250.0
		if _, err := e.aiStudent.UpdateWatchProgress(ctx, &richterv1.UpdateWatchProgressRequest{
			LessonId: e.lessonID, PositionSeconds: newPos,
		}); err != nil {
			t.Fatalf("UpdateWatchProgress: %v", err)
		}
		res, err := e.aiStudent.GetWatchProgress(ctx, &richterv1.GetWatchProgressRequest{LessonId: e.lessonID})
		if err != nil {
			t.Fatalf("GetWatchProgress: %v", err)
		}
		if res.PositionSeconds != newPos {
			t.Errorf("position after update: want %v, got %v", newPos, res.PositionSeconds)
		}
	})

	t.Run("PerUserIsolation", func(t *testing.T) {
		// student2 has not saved any progress — should still be 0.
		res, err := e.aiStudent2.GetWatchProgress(ctx, &richterv1.GetWatchProgressRequest{LessonId: e.lessonID})
		if err != nil {
			t.Fatalf("GetWatchProgress for student2: %v", err)
		}
		if res.PositionSeconds != 0 {
			t.Errorf("student2 should see 0 (not student1's progress), got %v", res.PositionSeconds)
		}
		// student2 saves their own position.
		const pos2 float32 = 75.0
		if _, err := e.aiStudent2.UpdateWatchProgress(ctx, &richterv1.UpdateWatchProgressRequest{
			LessonId: e.lessonID, PositionSeconds: pos2,
		}); err != nil {
			t.Fatalf("UpdateWatchProgress student2: %v", err)
		}
		res2, err := e.aiStudent2.GetWatchProgress(ctx, &richterv1.GetWatchProgressRequest{LessonId: e.lessonID})
		if err != nil {
			t.Fatalf("GetWatchProgress student2 after save: %v", err)
		}
		if res2.PositionSeconds != pos2 {
			t.Errorf("student2 position: want %v, got %v", pos2, res2.PositionSeconds)
		}
		// student1's progress should be unaffected.
		res1, err := e.aiStudent.GetWatchProgress(ctx, &richterv1.GetWatchProgressRequest{LessonId: e.lessonID})
		if err != nil {
			t.Fatalf("GetWatchProgress student1 after student2 save: %v", err)
		}
		if res1.PositionSeconds == pos2 {
			t.Error("student1's progress should not be overwritten by student2")
		}
	})

	t.Run("TeacherIndependentProgress", func(t *testing.T) {
		const teacherPos float32 = 500.0
		if _, err := e.aiTeacher.UpdateWatchProgress(ctx, &richterv1.UpdateWatchProgressRequest{
			LessonId: e.lessonID, PositionSeconds: teacherPos,
		}); err != nil {
			t.Fatalf("UpdateWatchProgress teacher: %v", err)
		}
		res, err := e.aiTeacher.GetWatchProgress(ctx, &richterv1.GetWatchProgressRequest{LessonId: e.lessonID})
		if err != nil {
			t.Fatalf("GetWatchProgress teacher: %v", err)
		}
		if res.PositionSeconds != teacherPos {
			t.Errorf("teacher position: want %v, got %v", teacherPos, res.PositionSeconds)
		}
	})

	t.Run("InvalidLessonID", func(t *testing.T) {
		assertCode(t, func() error {
			_, err := e.aiStudent.UpdateWatchProgress(ctx, &richterv1.UpdateWatchProgressRequest{
				LessonId: "not-a-uuid", PositionSeconds: 10,
			})
			return err
		}(), connect.CodeInvalidArgument)
	})
}

// ── TestAIQuestionEditing ─────────────────────────────────────────────────────

func TestAIQuestionEditing(t *testing.T) {
	e := setupAIEnv(t)
	ctx := context.Background()

	// Seed 2 questions for the lesson.
	questions := insertTestQuestions(t, e.lessonID, 2)
	q0ID := questions[0].ID.String()

	t.Run("CreateManualQuestion/Teacher/OK", func(t *testing.T) {
		opts := []string{"A", "B", "C", "D"}
		res, err := e.aiTeacher.CreateManualQuestion(ctx, &richterv1.CreateManualQuestionRequest{
			LessonId:      e.lessonID,
			QuestionText:  gofakeit.Sentence(5),
			Options:       opts,
			CorrectAnswer: 1,
			Explanation:   "explanation",
			StartSeconds:  10.0,
		})
		if err != nil {
			t.Fatalf("CreateManualQuestion: %v", err)
		}
		if res.Question == nil {
			t.Fatal("expected question in response")
		}
		if res.Question.CorrectAnswer != 1 {
			t.Errorf("correct_answer: want 1, got %d", res.Question.CorrectAnswer)
		}
	})

	t.Run("CreateManualQuestion/Student/PermissionDenied", func(t *testing.T) {
		assertCode(t, func() error {
			_, err := e.aiStudent.CreateManualQuestion(ctx, &richterv1.CreateManualQuestionRequest{
				LessonId:      e.lessonID,
				QuestionText:  "q?",
				Options:       []string{"A", "B", "C", "D"},
				CorrectAnswer: 0,
				StartSeconds:  0,
			})
			return err
		}(), connect.CodePermissionDenied)
	})

	t.Run("CreateManualQuestion/NonMember/PermissionDenied", func(t *testing.T) {
		assertCode(t, func() error {
			_, err := e.aiNonMember.CreateManualQuestion(ctx, &richterv1.CreateManualQuestionRequest{
				LessonId:      e.lessonID,
				QuestionText:  "q?",
				Options:       []string{"A", "B", "C", "D"},
				CorrectAnswer: 0,
				StartSeconds:  0,
			})
			return err
		}(), connect.CodePermissionDenied)
	})

	t.Run("UpdateLessonQuestion/Teacher/OK", func(t *testing.T) {
		newText := gofakeit.Sentence(6)
		res, err := e.aiTeacher.UpdateLessonQuestion(ctx, &richterv1.UpdateLessonQuestionRequest{
			QuestionId:    q0ID,
			QuestionText:  newText,
			Options:       []string{"X", "Y", "Z", "W"},
			CorrectAnswer: 2,
			Explanation:   "updated explanation",
			StartSeconds:  5.0,
		})
		if err != nil {
			t.Fatalf("UpdateLessonQuestion: %v", err)
		}
		if res.Question.QuestionText != newText {
			t.Errorf("question text: want %q, got %q", newText, res.Question.QuestionText)
		}
		if res.Question.CorrectAnswer != 2 {
			t.Errorf("correct_answer: want 2, got %d", res.Question.CorrectAnswer)
		}
	})

	t.Run("UpdateLessonQuestion/Student/PermissionDenied", func(t *testing.T) {
		assertCode(t, func() error {
			_, err := e.aiStudent.UpdateLessonQuestion(ctx, &richterv1.UpdateLessonQuestionRequest{
				QuestionId:    q0ID,
				QuestionText:  "hack",
				Options:       []string{"A", "B", "C", "D"},
				CorrectAnswer: 0,
				StartSeconds:  0,
			})
			return err
		}(), connect.CodePermissionDenied)
	})

	t.Run("DeleteLessonQuestion/Student/PermissionDenied", func(t *testing.T) {
		assertCode(t, func() error {
			_, err := e.aiStudent.DeleteLessonQuestion(ctx, &richterv1.DeleteLessonQuestionRequest{
				QuestionId: q0ID,
			})
			return err
		}(), connect.CodePermissionDenied)
	})

	t.Run("DeleteLessonQuestion/Teacher/OK", func(t *testing.T) {
		// Use the second question so q0ID still exists for other sub-tests.
		q1ID := questions[1].ID.String()
		if _, err := e.aiTeacher.DeleteLessonQuestion(ctx, &richterv1.DeleteLessonQuestionRequest{
			QuestionId: q1ID,
		}); err != nil {
			t.Fatalf("DeleteLessonQuestion: %v", err)
		}
		// Verify it's gone: GetLessonAnalysis should no longer return it.
		analysisRes, err := e.aiTeacher.GetLessonAnalysis(ctx, &richterv1.GetLessonAnalysisRequest{LessonId: e.lessonID})
		if err != nil {
			t.Fatalf("GetLessonAnalysis: %v", err)
		}
		for _, q := range analysisRes.Analysis.GetQuestions() {
			if q.Id == q1ID {
				t.Errorf("deleted question %s still present in analysis", q1ID)
			}
		}
	})

	t.Run("UpdateLessonQuestion/InvalidOptions/BadRequest", func(t *testing.T) {
		// Correct answer index out of range for given options count.
		assertCode(t, func() error {
			_, err := e.aiTeacher.UpdateLessonQuestion(ctx, &richterv1.UpdateLessonQuestionRequest{
				QuestionId:    q0ID,
				QuestionText:  "q?",
				Options:       []string{"A", "B", "C", "D"},
				CorrectAnswer: -1, // protovalidate: gte=0 should reject this
				StartSeconds:  0,
			})
			return err
		}(), connect.CodeInvalidArgument)
	})
}

// ── TestAIChunkConfig ─────────────────────────────────────────────────────────

func TestAIChunkConfig(t *testing.T) {
	e := setupAIEnv(t)
	ctx := context.Background()

	chunk := insertTestChunk(t, e.lessonID, 0, "transcript content for chunk test")
	chunkID := chunk.ID.String()

	t.Run("ListLessonTranscriptChunks/ReturnsInserted", func(t *testing.T) {
		res, err := e.aiTeacher.ListLessonTranscriptChunks(ctx, &richterv1.ListLessonTranscriptChunksRequest{
			LessonId: e.lessonID,
		})
		if err != nil {
			t.Fatalf("ListLessonTranscriptChunks: %v", err)
		}
		if len(res.Chunks) == 0 {
			t.Fatal("expected at least one chunk")
		}
		found := false
		for _, c := range res.Chunks {
			if c.Id == chunkID {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("inserted chunk %s not found in list", chunkID)
		}
	})

	t.Run("UpdateChunkConfig/Teacher/OK", func(t *testing.T) {
		res, err := e.aiTeacher.UpdateChunkConfig(ctx, &richterv1.UpdateChunkConfigRequest{
			ChunkId:       chunkID,
			QuestionCount: 3,
		})
		if err != nil {
			t.Fatalf("UpdateChunkConfig: %v", err)
		}
		if res.Chunk == nil {
			t.Fatal("expected chunk in response")
		}
		if res.Chunk.QuestionCountConfig != 3 {
			t.Errorf("question_count: want 3, got %d", res.Chunk.QuestionCountConfig)
		}
	})

	t.Run("UpdateChunkConfig/Student/PermissionDenied", func(t *testing.T) {
		assertCode(t, func() error {
			_, err := e.aiStudent.UpdateChunkConfig(ctx, &richterv1.UpdateChunkConfigRequest{
				ChunkId:       chunkID,
				QuestionCount: 5,
			})
			return err
		}(), connect.CodePermissionDenied)
	})

	t.Run("UpdateChunkConfig/NonMember/PermissionDenied", func(t *testing.T) {
		assertCode(t, func() error {
			_, err := e.aiNonMember.UpdateChunkConfig(ctx, &richterv1.UpdateChunkConfigRequest{
				ChunkId:       chunkID,
				QuestionCount: 5,
			})
			return err
		}(), connect.CodePermissionDenied)
	})

	t.Run("UpdateChunkConfig/InvalidChunkID", func(t *testing.T) {
		assertCode(t, func() error {
			_, err := e.aiTeacher.UpdateChunkConfig(ctx, &richterv1.UpdateChunkConfigRequest{
				ChunkId:       "not-a-uuid",
				QuestionCount: 1,
			})
			return err
		}(), connect.CodeInvalidArgument)
	})

	// MergeChunks and DeleteChunk tests need at least 2 chunks.
	chunk2 := insertTestChunk(t, e.lessonID, 1, "second chunk transcript")
	chunk2ID := chunk2.ID.String()

	t.Run("MergeChunks/Student/PermissionDenied", func(t *testing.T) {
		assertCode(t, func() error {
			_, err := e.aiStudent.MergeChunks(ctx, &richterv1.MergeChunksRequest{
				KeepChunkId:    chunkID,
				DiscardChunkId: chunk2ID,
			})
			return err
		}(), connect.CodePermissionDenied)
	})

	t.Run("MergeChunks/NonMember/PermissionDenied", func(t *testing.T) {
		assertCode(t, func() error {
			_, err := e.aiNonMember.MergeChunks(ctx, &richterv1.MergeChunksRequest{
				KeepChunkId:    chunkID,
				DiscardChunkId: chunk2ID,
			})
			return err
		}(), connect.CodePermissionDenied)
	})

	t.Run("MergeChunks/SameChunk/InvalidArgument", func(t *testing.T) {
		assertCode(t, func() error {
			_, err := e.aiTeacher.MergeChunks(ctx, &richterv1.MergeChunksRequest{
				KeepChunkId:    chunkID,
				DiscardChunkId: chunkID,
			})
			return err
		}(), connect.CodeInvalidArgument)
	})

	t.Run("MergeChunks/DifferentLessons/InvalidArgument", func(t *testing.T) {
		// Create a second lesson to get a chunk belonging to a different lesson.
		lesson2Res, err := e.adminLessons.CreateLesson(ctx, &richterv1.CreateLessonRequest{
			ModuleId: e.moduleID, Title: gofakeit.JobTitle(), OrderIndex: 99,
		})
		if err != nil {
			t.Fatalf("create second lesson: %v", err)
		}
		otherChunk := insertTestChunk(t, lesson2Res.Lesson.Id, 0, "other lesson chunk")

		assertCode(t, func() error {
			_, err := e.aiTeacher.MergeChunks(ctx, &richterv1.MergeChunksRequest{
				KeepChunkId:    chunkID,
				DiscardChunkId: otherChunk.ID.String(),
			})
			return err
		}(), connect.CodeInvalidArgument)
	})

	t.Run("DeleteChunk/Student/PermissionDenied", func(t *testing.T) {
		assertCode(t, func() error {
			_, err := e.aiStudent.DeleteChunk(ctx, &richterv1.DeleteChunkRequest{ChunkId: chunk2ID})
			return err
		}(), connect.CodePermissionDenied)
	})

	t.Run("DeleteChunk/NonMember/PermissionDenied", func(t *testing.T) {
		assertCode(t, func() error {
			_, err := e.aiNonMember.DeleteChunk(ctx, &richterv1.DeleteChunkRequest{ChunkId: chunk2ID})
			return err
		}(), connect.CodePermissionDenied)
	})

	t.Run("DeleteChunk/InvalidChunkID", func(t *testing.T) {
		assertCode(t, func() error {
			_, err := e.aiTeacher.DeleteChunk(ctx, &richterv1.DeleteChunkRequest{ChunkId: "not-a-uuid"})
			return err
		}(), connect.CodeInvalidArgument)
	})
}

// insertTestQuestionsForChunk inserts questions for a specific chunk in the DB.
// Unlike insertTestQuestions, it does NOT delete existing questions for the lesson.
func insertTestQuestionsForChunk(t *testing.T, lessonID, chunkIDStr string, count int) []gen.LessonQuestion {
	t.Helper()
	pool, err := do.Invoke[*db.PostgresSvc](internal.Injector)
	if err != nil {
		t.Fatalf("get db: %v", err)
	}
	var lid pgtype.UUID
	if err := lid.Scan(lessonID); err != nil {
		t.Fatalf("parse lessonID: %v", err)
	}
	var cid pgtype.UUID
	if err := cid.Scan(chunkIDStr); err != nil {
		t.Fatalf("parse chunkID: %v", err)
	}
	questions := make([]gen.LessonQuestion, 0, count)
	for i := range count {
		optJSON, _ := json.Marshal([]string{"A", "B", "C", "D"})
		lq, err := db.WithConnection(pool, context.Background(), func(q *gen.Queries, _ *pgxpool.Conn) (gen.LessonQuestion, error) {
			return q.CreateLessonQuestion(context.Background(), gen.CreateLessonQuestionParams{
				LessonID:      lid,
				QuestionText:  gofakeit.Sentence(6),
				Options:       optJSON,
				CorrectAnswer: 0,
				Explanation:   pgtype.Text{},
				OrderIndex:    int32(i),
				StartSeconds:  float64(i * 30),
				ChunkID:       cid,
			})
		})
		if err != nil {
			t.Fatalf("create question for chunk %d: %v", i, err)
		}
		questions = append(questions, lq)
	}
	return questions
}

// ── TestAIStatusMapping ───────────────────────────────────────────────────────

// TestAIStatusMapping verifies that all lesson_analysis_status enum values are
// correctly mapped to their proto equivalents in GetLessonAnalysis.
func TestAIStatusMapping(t *testing.T) {
	e := setupAIEnv(t)
	ctx := context.Background()

	cases := []struct {
		dbStatus    gen.LessonAnalysisStatus
		protoStatus richterv1.AnalysisStatus
		name        string
	}{
		{gen.LessonAnalysisStatusProcessing, richterv1.AnalysisStatus_ANALYSIS_STATUS_PROCESSING, "Processing"},
		{gen.LessonAnalysisStatusTranscriptExtracted, richterv1.AnalysisStatus_ANALYSIS_STATUS_TRANSCRIPT_EXTRACTED, "TranscriptExtracted"},
		{gen.LessonAnalysisStatusChunksReady, richterv1.AnalysisStatus_ANALYSIS_STATUS_CHUNKS_READY, "ChunksReady"},
		{gen.LessonAnalysisStatusDone, richterv1.AnalysisStatus_ANALYSIS_STATUS_DONE, "Done"},
		{gen.LessonAnalysisStatusError, richterv1.AnalysisStatus_ANALYSIS_STATUS_ERROR, "Error"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			insertTestAnalysis(t, e.lessonID, tc.dbStatus)
			res, err := e.aiStudent.GetLessonAnalysis(ctx, &richterv1.GetLessonAnalysisRequest{LessonId: e.lessonID})
			if err != nil {
				t.Fatalf("GetLessonAnalysis: %v", err)
			}
			if res.Analysis == nil {
				t.Fatal("expected analysis in response")
			}
			if res.Analysis.Status != tc.protoStatus {
				t.Errorf("status: want %v, got %v", tc.protoStatus, res.Analysis.Status)
			}
		})
	}
}

// ── TestAIGenerateQuestionsResumable ─────────────────────────────────────────

// TestAIGenerateQuestionsResumable verifies the skip-if-already-done logic and
// force_regenerate override introduced for pipeline resumability.
func TestAIGenerateQuestionsResumable(t *testing.T) {
	e := setupAIEnv(t)
	ctx := context.Background()

	// Setup: transcript_extracted status + two chunks, both with pre-existing questions.
	// This simulates a run that completed all chunks but was killed before setting status=done.
	insertTestAnalysis(t, e.lessonID, gen.LessonAnalysisStatusTranscriptExtracted)
	chunk0 := insertTestChunk(t, e.lessonID, 0, "first chunk transcript")
	chunk1 := insertTestChunk(t, e.lessonID, 1, "second chunk transcript")
	insertTestQuestionsForChunk(t, e.lessonID, chunk0.ID.String(), 1)
	insertTestQuestionsForChunk(t, e.lessonID, chunk1.ID.String(), 1)

	streamAll := func(t *testing.T, req *richterv1.GenerateQuestionsRequest) []*richterv1.GenerateQuestionsProgressEvent {
		t.Helper()
		s, err := e.aiTeacher.GenerateQuestionsStream(ctx, req)
		if err != nil {
			t.Fatalf("GenerateQuestionsStream call: %v", err)
		}
		var events []*richterv1.GenerateQuestionsProgressEvent
		for s.Receive() {
			events = append(events, s.Msg())
		}
		if err := s.Err(); err != nil {
			t.Fatalf("stream error: %v", err)
		}
		return events
	}

	t.Run("AllChunksPreDone/SkipsAll", func(t *testing.T) {
		events := streamAll(t, &richterv1.GenerateQuestionsRequest{LessonId: e.lessonID})

		// Expect: skip(chunk0), skip(chunk1), DONE — 3 events total.
		if len(events) != 3 {
			t.Fatalf("expected 3 events (2 skips + DONE), got %d: %v", len(events), events)
		}

		// First two events: CHUNK step with "bỏ qua" message.
		for i, ev := range events[:2] {
			if ev.Step != richterv1.GenerateQuestionsStep_GENERATE_QUESTIONS_STEP_CHUNK {
				t.Errorf("event[%d]: want CHUNK step, got %v", i, ev.Step)
			}
			if !strings.Contains(ev.Message, "bỏ qua") {
				t.Errorf("event[%d]: expected skip message containing 'bỏ qua', got %q", i, ev.Message)
			}
			if ev.TotalChunks != 2 {
				t.Errorf("event[%d]: want TotalChunks=2, got %d", i, ev.TotalChunks)
			}
		}

		// Last event: DONE.
		last := events[len(events)-1]
		if last.Step != richterv1.GenerateQuestionsStep_GENERATE_QUESTIONS_STEP_DONE {
			t.Errorf("last event: want DONE, got %v", last.Step)
		}
	})

	t.Run("AllChunksPreDone/SetsAnalysisStatusDone", func(t *testing.T) {
		streamAll(t, &richterv1.GenerateQuestionsRequest{LessonId: e.lessonID})

		res, err := e.aiTeacher.GetLessonAnalysis(ctx, &richterv1.GetLessonAnalysisRequest{LessonId: e.lessonID})
		if err != nil {
			t.Fatalf("GetLessonAnalysis: %v", err)
		}
		if res.Analysis.Status != richterv1.AnalysisStatus_ANALYSIS_STATUS_DONE {
			t.Errorf("analysis status: want DONE after all chunks skipped, got %v", res.Analysis.Status)
		}
	})

	t.Run("ForceRegenerate/DoesNotSkip", func(t *testing.T) {
		// force_regenerate=true must attempt Gemini even for pre-questioned chunks.
		// If Gemini is not reachable/not configured, this produces an ERROR event (not a skip).
		forceCtx, forceCancel := context.WithTimeout(ctx, 3*time.Minute)
		defer forceCancel()
		s, err := e.aiTeacher.GenerateQuestionsStream(forceCtx, &richterv1.GenerateQuestionsRequest{
			LessonId:        e.lessonID,
			ForceRegenerate: true,
		})
		if err != nil {
			t.Fatalf("GenerateQuestionsStream call: %v", err)
		}
		var events []*richterv1.GenerateQuestionsProgressEvent
		for s.Receive() {
			events = append(events, s.Msg())
		}
		_ = s.Err() // stream may end with error

		if len(events) == 0 {
			t.Fatal("expected at least one event")
		}
		// First CHUNK event must NOT contain "bỏ qua".
		firstChunk := events[0]
		if firstChunk.Step == richterv1.GenerateQuestionsStep_GENERATE_QUESTIONS_STEP_CHUNK &&
			strings.Contains(firstChunk.Message, "bỏ qua") {
			t.Error("force_regenerate=true should not produce skip events")
		}
	})

	t.Run("SingleChunkMode/DoesNotSkip", func(t *testing.T) {
		// chunk_id set → single-chunk mode → always regenerates regardless of existing questions.
		singleCtx, singleCancel := context.WithTimeout(ctx, 3*time.Minute)
		defer singleCancel()
		s, err := e.aiTeacher.GenerateQuestionsStream(singleCtx, &richterv1.GenerateQuestionsRequest{
			LessonId: e.lessonID,
			ChunkId:  chunk0.ID.String(),
		})
		if err != nil {
			t.Fatalf("GenerateQuestionsStream call: %v", err)
		}
		var events []*richterv1.GenerateQuestionsProgressEvent
		for s.Receive() {
			events = append(events, s.Msg())
		}
		_ = s.Err()

		if len(events) == 0 {
			t.Fatal("expected at least one event in single-chunk mode")
		}
		// Should not be a CHUNK-step skip event ("đã có câu hỏi, bỏ qua").
		// An ERROR-step event is acceptable (e.g. Gemini rate limit) — it means
		// we attempted generation, which is the correct behaviour for single-chunk mode.
		if events[0].Step == richterv1.GenerateQuestionsStep_GENERATE_QUESTIONS_STEP_CHUNK &&
			strings.Contains(events[0].Message, "bỏ qua") {
			t.Error("single-chunk mode must not skip even when chunk already has questions")
		}
	})
}

// ── TestAIFDBContent ──────────────────────────────────────────────────────────

func TestAIFDBContent(t *testing.T) {
	e := setupAIEnv(t)
	ctx := context.Background()

	// Insert DB analysis row (no transcript stored in PG — mirrors production behaviour).
	insertTestAnalysis(t, e.lessonID, gen.LessonAnalysisStatusDone)

	// Write transcript + segments to FDB directly.
	kvSvc, err := do.Invoke[*kv.KVSvc](internal.Injector)
	if err != nil {
		t.Fatalf("invoke KVSvc: %v", err)
	}

	const wantTranscript = "This is the FDB-stored transcript for the lesson."
	type segmentShape struct {
		StartSeconds float32 `json:"start_seconds"`
		EndSeconds   float32 `json:"end_seconds"`
		Text         string  `json:"text"`
	}
	wantSegments := []segmentShape{{StartSeconds: 0, EndSeconds: 10, Text: "hello"}}
	segmentsJSON, _ := json.Marshal(wantSegments)

	if err := kvSvc.Set("lesson", tuple.Tuple{e.lessonID, "transcript"}, []byte(wantTranscript)); err != nil {
		t.Fatalf("FDB Set transcript: %v", err)
	}
	if err := kvSvc.Set("lesson", tuple.Tuple{e.lessonID, "segments"}, segmentsJSON); err != nil {
		t.Fatalf("FDB Set segments: %v", err)
	}

	t.Run("GetLessonAnalysis/ReturnsFDBTranscript", func(t *testing.T) {
		res, err := e.aiStudent.GetLessonAnalysis(ctx, &richterv1.GetLessonAnalysisRequest{LessonId: e.lessonID})
		if err != nil {
			t.Fatalf("GetLessonAnalysis: %v", err)
		}
		if res.Analysis == nil {
			t.Fatal("expected analysis in response")
		}
		if res.Analysis.Transcript != wantTranscript {
			t.Errorf("transcript: want %q, got %q", wantTranscript, res.Analysis.Transcript)
		}
	})

	t.Run("GetLessonAnalysis/ReturnsFDBSegments", func(t *testing.T) {
		res, err := e.aiStudent.GetLessonAnalysis(ctx, &richterv1.GetLessonAnalysisRequest{LessonId: e.lessonID})
		if err != nil {
			t.Fatalf("GetLessonAnalysis: %v", err)
		}
		if len(res.Analysis.GetTranscriptSegments()) == 0 {
			t.Error("expected non-empty transcript segments from FDB")
		}
	})

}

// ── TestAITranscriptSegmentEditing ───────────────────────────────────────────

func TestAITranscriptSegmentEditing(t *testing.T) {
	e := setupAIEnv(t)
	ctx := context.Background()

	// Write segments to FDB directly (mirrors what ExtractTranscriptStream does).
	kvSvc, err := do.Invoke[*kv.KVSvc](internal.Injector)
	if err != nil {
		t.Fatalf("invoke KVSvc: %v", err)
	}
	type segShape struct {
		StartSeconds float32 `json:"start_seconds"`
		EndSeconds   float32 `json:"end_seconds"`
		Text         string  `json:"text"`
	}
	initialSegs := []segShape{
		{StartSeconds: 0, EndSeconds: 15, Text: "First segment text."},
		{StartSeconds: 15, EndSeconds: 30, Text: "Second segment text."},
	}
	segsJSON, _ := json.Marshal(initialSegs)
	if err := kvSvc.Set("lesson", tuple.Tuple{e.lessonID, "segments"}, segsJSON); err != nil {
		t.Fatalf("FDB Set segments: %v", err)
	}

	t.Run("UpdateIndex0/Teacher/OK", func(t *testing.T) {
		newText := "Updated first segment."
		res, err := e.aiTeacher.UpdateTranscriptSegment(ctx, &richterv1.UpdateTranscriptSegmentRequest{
			LessonId:     e.lessonID,
			SegmentIndex: 0,
			Text:         newText,
		})
		if err != nil {
			t.Fatalf("UpdateTranscriptSegment: %v", err)
		}
		if res.Segment == nil {
			t.Fatal("expected segment in response")
		}
		if res.Segment.Text != newText {
			t.Errorf("text: want %q, got %q", newText, res.Segment.Text)
		}
		if res.Segment.StartSeconds != 0 {
			t.Errorf("start_seconds: want 0, got %v", res.Segment.StartSeconds)
		}
	})

	t.Run("UpdateIndex0/Persists", func(t *testing.T) {
		// Verify the update persisted in FDB by calling UpdateTranscriptSegment again and checking.
		res, err := e.aiTeacher.UpdateTranscriptSegment(ctx, &richterv1.UpdateTranscriptSegmentRequest{
			LessonId:     e.lessonID,
			SegmentIndex: 1,
			Text:         "Updated second.",
		})
		if err != nil {
			t.Fatalf("UpdateTranscriptSegment index 1: %v", err)
		}
		if res.Segment.Text != "Updated second." {
			t.Errorf("text: want %q, got %q", "Updated second.", res.Segment.Text)
		}
	})

	t.Run("IndexOutOfRange/InvalidArgument", func(t *testing.T) {
		assertCode(t, func() error {
			_, err := e.aiTeacher.UpdateTranscriptSegment(ctx, &richterv1.UpdateTranscriptSegmentRequest{
				LessonId:     e.lessonID,
				SegmentIndex: 99,
				Text:         "out of range",
			})
			return err
		}(), connect.CodeInvalidArgument)
	})

	t.Run("EmptyText/InvalidArgument", func(t *testing.T) {
		// protovalidate: text min_len=1 should reject empty string.
		assertCode(t, func() error {
			_, err := e.aiTeacher.UpdateTranscriptSegment(ctx, &richterv1.UpdateTranscriptSegmentRequest{
				LessonId:     e.lessonID,
				SegmentIndex: 0,
				Text:         "",
			})
			return err
		}(), connect.CodeInvalidArgument)
	})

	t.Run("InvalidLessonID/InvalidArgument", func(t *testing.T) {
		assertCode(t, func() error {
			_, err := e.aiTeacher.UpdateTranscriptSegment(ctx, &richterv1.UpdateTranscriptSegmentRequest{
				LessonId:     "not-a-uuid",
				SegmentIndex: 0,
				Text:         "text",
			})
			return err
		}(), connect.CodeInvalidArgument)
	})
}

// ── TestAIChunkOperations ─────────────────────────────────────────────────────

func TestAIChunkOperations(t *testing.T) {
	e := setupAIEnv(t)
	ctx := context.Background()

	// cleanLesson removes all chunks (and their questions) for the lesson so each
	// sub-test starts from a known, empty state.
	cleanLesson := func() {
		t.Helper()
		pool, err := do.Invoke[*db.PostgresSvc](internal.Injector)
		if err != nil {
			t.Fatalf("get db: %v", err)
		}
		var lid pgtype.UUID
		if err := lid.Scan(e.lessonID); err != nil {
			t.Fatalf("parse lessonID: %v", err)
		}
		if err := db.WithConnectionExec(pool, context.Background(), func(q *gen.Queries, _ *pgxpool.Conn) error {
			chunks, _ := q.ListLessonTranscriptChunks(context.Background(), lid)
			for _, c := range chunks {
				_ = q.DeleteLessonQuestionsForChunk(context.Background(), c.ID)
			}
			return q.DeleteLessonTranscriptChunks(context.Background(), lid)
		}); err != nil {
			t.Fatalf("cleanLesson: %v", err)
		}
	}

	insertAnalysis := func() {
		t.Helper()
		cleanLesson()
		insertTestAnalysis(t, e.lessonID, gen.LessonAnalysisStatusChunksReady)
	}

	// ── MergeChunks ──────────────────────────────────────────────────────────

	t.Run("MergeChunks/Adjacent/OK", func(t *testing.T) {
		insertAnalysis()
		c0 := insertTestChunk(t, e.lessonID, 0, "first chunk")
		c1 := insertTestChunk(t, e.lessonID, 1, "second chunk")

		res, err := e.aiTeacher.MergeChunks(ctx, &richterv1.MergeChunksRequest{
			KeepChunkId:    c0.ID.String(),
			DiscardChunkId: c1.ID.String(),
		})
		if err != nil {
			t.Fatalf("MergeChunks: %v", err)
		}
		if res.MergedChunk == nil {
			t.Fatal("expected merged chunk in response")
		}
		// Merged boundaries should span both chunks.
		if res.MergedChunk.StartSeconds != float32(c0.StartSeconds) {
			t.Errorf("start_seconds: want %v, got %v", c0.StartSeconds, res.MergedChunk.StartSeconds)
		}
		if res.MergedChunk.EndSeconds != float32(c1.EndSeconds) {
			t.Errorf("end_seconds: want %v, got %v", c1.EndSeconds, res.MergedChunk.EndSeconds)
		}
		// Discard chunk should no longer be listable.
		listRes, err := e.aiTeacher.ListLessonTranscriptChunks(ctx, &richterv1.ListLessonTranscriptChunksRequest{
			LessonId: e.lessonID,
		})
		if err != nil {
			t.Fatalf("ListLessonTranscriptChunks after merge: %v", err)
		}
		for _, c := range listRes.Chunks {
			if c.Id == c1.ID.String() {
				t.Errorf("discarded chunk %s should be gone after merge", c1.ID.String())
			}
		}
	})

	t.Run("MergeChunks/NonAdjacent/InvalidArgument", func(t *testing.T) {
		insertAnalysis()
		c0 := insertTestChunk(t, e.lessonID, 0, "chunk0")
		_ = insertTestChunk(t, e.lessonID, 1, "chunk1")
		c2 := insertTestChunk(t, e.lessonID, 2, "chunk2")

		assertCode(t, func() error {
			_, err := e.aiTeacher.MergeChunks(ctx, &richterv1.MergeChunksRequest{
				KeepChunkId:    c0.ID.String(),
				DiscardChunkId: c2.ID.String(),
			})
			return err
		}(), connect.CodeInvalidArgument)
	})

	t.Run("MergeChunks/QuestionsDeletedForDiscard", func(t *testing.T) {
		insertAnalysis()
		c0 := insertTestChunk(t, e.lessonID, 0, "first")
		c1 := insertTestChunk(t, e.lessonID, 1, "second")
		qs := insertTestQuestionsForChunk(t, e.lessonID, c1.ID.String(), 2)

		if _, err := e.aiTeacher.MergeChunks(ctx, &richterv1.MergeChunksRequest{
			KeepChunkId:    c0.ID.String(),
			DiscardChunkId: c1.ID.String(),
		}); err != nil {
			t.Fatalf("MergeChunks: %v", err)
		}

		// Verify discard chunk's questions are gone.
		analysisRes, err := e.aiTeacher.GetLessonAnalysis(ctx, &richterv1.GetLessonAnalysisRequest{LessonId: e.lessonID})
		if err != nil {
			t.Fatalf("GetLessonAnalysis: %v", err)
		}
		discardQIDs := map[string]bool{qs[0].ID.String(): true, qs[1].ID.String(): true}
		for _, q := range analysisRes.Analysis.GetQuestions() {
			if discardQIDs[q.Id] {
				t.Errorf("question %s from discarded chunk still present", q.Id)
			}
		}
	})

	t.Run("MergeChunks/ReordersAfterMerge", func(t *testing.T) {
		insertAnalysis()
		c0 := insertTestChunk(t, e.lessonID, 0, "a")
		c1 := insertTestChunk(t, e.lessonID, 1, "b")
		c2 := insertTestChunk(t, e.lessonID, 2, "c")

		// Merge c0+c1, then c2 should have order_index=1.
		if _, err := e.aiTeacher.MergeChunks(ctx, &richterv1.MergeChunksRequest{
			KeepChunkId:    c0.ID.String(),
			DiscardChunkId: c1.ID.String(),
		}); err != nil {
			t.Fatalf("MergeChunks: %v", err)
		}
		listRes, err := e.aiTeacher.ListLessonTranscriptChunks(ctx, &richterv1.ListLessonTranscriptChunksRequest{
			LessonId: e.lessonID,
		})
		if err != nil {
			t.Fatalf("ListLessonTranscriptChunks: %v", err)
		}
		if len(listRes.Chunks) != 2 {
			t.Fatalf("expected 2 chunks after merge of 3, got %d", len(listRes.Chunks))
		}
		// After reorder: order indices should be 0, 1.
		for i, c := range listRes.Chunks {
			if int(c.OrderIndex) != i {
				t.Errorf("chunk[%d].order_index: want %d, got %d", i, i, c.OrderIndex)
			}
		}
		// c2 should still be present.
		found := false
		for _, c := range listRes.Chunks {
			if c.Id == c2.ID.String() {
				found = true
			}
		}
		if !found {
			t.Errorf("chunk c2 should still be present after merging c0+c1")
		}
	})

	// ── DeleteChunk ──────────────────────────────────────────────────────────

	t.Run("DeleteChunk/OK", func(t *testing.T) {
		insertAnalysis()
		c := insertTestChunk(t, e.lessonID, 0, "to delete")
		cID := c.ID.String()

		if _, err := e.aiTeacher.DeleteChunk(ctx, &richterv1.DeleteChunkRequest{ChunkId: cID}); err != nil {
			t.Fatalf("DeleteChunk: %v", err)
		}
		listRes, err := e.aiTeacher.ListLessonTranscriptChunks(ctx, &richterv1.ListLessonTranscriptChunksRequest{
			LessonId: e.lessonID,
		})
		if err != nil {
			t.Fatalf("ListLessonTranscriptChunks after delete: %v", err)
		}
		for _, c2 := range listRes.Chunks {
			if c2.Id == cID {
				t.Errorf("deleted chunk %s still in list", cID)
			}
		}
	})

	t.Run("DeleteChunk/AlsoDeletesQuestions", func(t *testing.T) {
		insertAnalysis()
		c := insertTestChunk(t, e.lessonID, 0, "chunk with questions")
		qs := insertTestQuestionsForChunk(t, e.lessonID, c.ID.String(), 3)

		if _, err := e.aiTeacher.DeleteChunk(ctx, &richterv1.DeleteChunkRequest{ChunkId: c.ID.String()}); err != nil {
			t.Fatalf("DeleteChunk: %v", err)
		}
		analysisRes, err := e.aiTeacher.GetLessonAnalysis(ctx, &richterv1.GetLessonAnalysisRequest{LessonId: e.lessonID})
		if err != nil {
			t.Fatalf("GetLessonAnalysis: %v", err)
		}
		deletedQIDs := map[string]bool{qs[0].ID.String(): true, qs[1].ID.String(): true, qs[2].ID.String(): true}
		for _, q := range analysisRes.Analysis.GetQuestions() {
			if deletedQIDs[q.Id] {
				t.Errorf("question %s from deleted chunk still present", q.Id)
			}
		}
	})

	t.Run("DeleteChunk/MiddleChunk/ReordersRemaining", func(t *testing.T) {
		insertAnalysis()
		c0 := insertTestChunk(t, e.lessonID, 0, "first")
		c1 := insertTestChunk(t, e.lessonID, 1, "middle — to delete")
		c2 := insertTestChunk(t, e.lessonID, 2, "last")

		if _, err := e.aiTeacher.DeleteChunk(ctx, &richterv1.DeleteChunkRequest{ChunkId: c1.ID.String()}); err != nil {
			t.Fatalf("DeleteChunk middle: %v", err)
		}
		listRes, err := e.aiTeacher.ListLessonTranscriptChunks(ctx, &richterv1.ListLessonTranscriptChunksRequest{
			LessonId: e.lessonID,
		})
		if err != nil {
			t.Fatalf("ListLessonTranscriptChunks: %v", err)
		}
		if len(listRes.Chunks) != 2 {
			t.Fatalf("expected 2 chunks after deleting middle, got %d", len(listRes.Chunks))
		}
		// order_index must be 0, 1.
		for i, c := range listRes.Chunks {
			if int(c.OrderIndex) != i {
				t.Errorf("chunk[%d].order_index: want %d, got %d", i, i, c.OrderIndex)
			}
		}
		// c0 and c2 must still exist.
		ids := map[string]bool{}
		for _, c := range listRes.Chunks {
			ids[c.Id] = true
		}
		if !ids[c0.ID.String()] {
			t.Errorf("c0 should remain after deleting middle chunk")
		}
		if !ids[c2.ID.String()] {
			t.Errorf("c2 should remain after deleting middle chunk")
		}
	})

	t.Run("DeleteChunk/NotFound", func(t *testing.T) {
		assertCode(t, func() error {
			_, err := e.aiTeacher.DeleteChunk(ctx, &richterv1.DeleteChunkRequest{
				ChunkId: "00000000-0000-0000-0000-000000000001",
			})
			return err
		}(), connect.CodeNotFound)
	})
}

// testUploadVideoToS3 uploads a local file to S3, with a presigned PUT fallback
// for SeaweedFS buckets that reject header-based auth.
func testUploadVideoToS3(t *testing.T, ctx context.Context, client *minio.Client, bucket, key, localPath string) error {
	t.Helper()
	f, err := os.Open(localPath)
	if err != nil {
		return fmt.Errorf("open %s: %w", localPath, err)
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return fmt.Errorf("stat: %w", err)
	}

	_, putErr := client.PutObject(ctx, bucket, key, f, info.Size(), minio.PutObjectOptions{ContentType: "video/mp4"})
	if putErr == nil {
		return nil
	}

	// Fallback: presigned PUT (SeaweedFS without IAM).
	presignURL, err := client.PresignedPutObject(ctx, bucket, key, 15*time.Minute)
	if err != nil {
		return fmt.Errorf("direct upload failed (%v); presign also failed: %w", putErr, err)
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return fmt.Errorf("seek: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, presignURL.String(), f)
	if err != nil {
		return fmt.Errorf("build presigned PUT request: %w", err)
	}
	req.ContentLength = info.Size()
	req.Header.Set("Content-Type", "video/mp4")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("presigned PUT: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusNoContent {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("presigned PUT status %d: %s", resp.StatusCode, body)
	}
	return nil
}

// ── TestAIPipelineFullFlow ────────────────────────────────────────────────────

// TestAIPipelineFullFlow runs the complete AI pipeline end-to-end:
//
//	ExtractTranscriptStream (Whisper transcription + Gemini chunking)
//	→ ChunkTranscriptStream (Gemini re-chunk, optional)
//	→ GenerateQuestionsStream (Gemini Q&A generation)
//
// Uses testdata/edu-sample.mp4 — a 14-second synthetic binary search lecture.
//
// Skip conditions:
//   - testdata/edu-sample.mp4 does not exist (run the script in testdata/README.md)
//   - Gemini API key not set (needed for chunking and Q&A generation)
//   - whisper.endpoint not set in richter.test.toml (needed for transcription)
func TestAIPipelineFullFlow(t *testing.T) {
	whisperCfg, err := do.Invoke[*cfg.WhisperCfg](internal.Injector)
	if err != nil || whisperCfg.Endpoint == "" {
		t.Skip("skipped: whisper.endpoint not configured — set whisper.endpoint in richter.test.toml")
	}
	geminiCfg, err := do.Invoke[*cfg.GeminiCfg](internal.Injector)
	if err != nil || geminiCfg.APIKey == "" {
		t.Skip("skipped: Gemini API key not configured — set gemini.api_key in richter.test.toml")
	}

	const videoPath = "../../../testdata/edu-sample.mp4"
	if _, statErr := os.Stat(videoPath); os.IsNotExist(statErr) {
		t.Skipf("skipped: test video not found at %s", videoPath)
	}

	e := setupAIEnv(t)
	ctx := context.Background()

	// Upload the educational test video to S3 test bucket.
	s3cfg, err := do.Invoke[*cfg.S3Cfg](internal.Injector)
	if err != nil {
		t.Fatalf("invoke S3Cfg: %v", err)
	}
	s3client, err := minio.New(s3cfg.Endpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(s3cfg.AccessKeyID, s3cfg.SecretAccessKey, ""),
		Secure: s3cfg.UseSSL,
	})
	if err != nil {
		t.Fatalf("create minio client: %v", err)
	}

	if exists, err := s3client.BucketExists(ctx, s3cfg.Bucket); err != nil {
		t.Fatalf("check bucket: %v", err)
	} else if !exists {
		if err := s3client.MakeBucket(ctx, s3cfg.Bucket, minio.MakeBucketOptions{}); err != nil {
			t.Fatalf("create bucket: %v", err)
		}
	}

	videoKey := fmt.Sprintf("test-pipeline/%s/edu-sample.mp4", e.lessonID)
	if err := testUploadVideoToS3(t, ctx, s3client, s3cfg.Bucket, videoKey, videoPath); err != nil {
		t.Fatalf("upload video to S3: %v", err)
	}
	t.Cleanup(func() {
		_ = s3client.RemoveObject(context.Background(), s3cfg.Bucket, videoKey, minio.RemoveObjectOptions{})
	})

	if _, err := e.adminLessons.UpdateLessonVideo(ctx, &richterv1.UpdateLessonVideoRequest{
		Id:              e.lessonID,
		VideoStorageKey: videoKey,
	}); err != nil {
		t.Fatalf("set video key on lesson: %v", err)
	}

	// ── Phase 1: ExtractTranscriptStream ───────────────────────────────────────
	// Run extraction outside sub-tests so a failure fatally stops generation.

	t.Log("Phase 1: ExtractTranscriptStream — Whisper transcription + Gemini chunking")
	{
		extractCtx, cancel := context.WithTimeout(ctx, 10*time.Minute)
		defer cancel()

		stream, err := e.aiTeacher.ExtractTranscriptStream(extractCtx, &richterv1.ExtractTranscriptRequest{
			LessonId: e.lessonID,
		})
		if err != nil {
			t.Fatalf("ExtractTranscriptStream call: %v", err)
		}
		var events []*richterv1.AnalysisProgressEvent
		for stream.Receive() {
			ev := stream.Msg()
			events = append(events, ev)
			t.Logf("  step=%v msg=%q", ev.Step, ev.Message)
		}
		if err := stream.Err(); err != nil {
			t.Fatalf("stream error: %v", err)
		}
		if len(events) == 0 {
			t.Fatal("no events received from ExtractTranscriptStream")
		}
		last := events[len(events)-1]
		if last.Step != richterv1.AnalysisProgressStep_ANALYSIS_PROGRESS_STEP_DONE {
			msg := last.Message
			if strings.Contains(msg, "429") || strings.Contains(strings.ToLower(msg), "quota") {
				t.Skipf("Gemini API rate limit exceeded — try again later: %s", msg)
			}
			t.Fatalf("extraction failed (step=%v): %s", last.Step, msg)
		}
	}

	t.Run("ExtractTranscript/StatusIsChunksReadyOrExtracted", func(t *testing.T) {
		res, err := e.aiTeacher.GetLessonAnalysis(ctx, &richterv1.GetLessonAnalysisRequest{LessonId: e.lessonID})
		if err != nil {
			t.Fatalf("GetLessonAnalysis: %v", err)
		}
		if res.Analysis == nil {
			t.Fatal("expected analysis in response")
		}
		// ExtractTranscriptStream now runs a combined Gemini call that returns transcript +
		// chunks in a single pass, so status goes directly to CHUNKS_READY.
		// It falls back to TRANSCRIPT_EXTRACTED only when Gemini returns no chunks.
		ok := res.Analysis.Status == richterv1.AnalysisStatus_ANALYSIS_STATUS_CHUNKS_READY ||
			res.Analysis.Status == richterv1.AnalysisStatus_ANALYSIS_STATUS_TRANSCRIPT_EXTRACTED
		if !ok {
			t.Errorf("status: want CHUNKS_READY or TRANSCRIPT_EXTRACTED, got %v", res.Analysis.Status)
		}
		if res.Analysis.Transcript == "" {
			t.Error("expected non-empty transcript after extraction")
		}
	})

	// ── Phase 2: ChunkTranscriptStream ────────────────────────────────────────

	t.Log("Phase 2: ChunkTranscriptStream — text-only Gemini call")
	{
		chunkCtx, cancel := context.WithTimeout(ctx, 5*time.Minute)
		defer cancel()

		stream, err := e.aiTeacher.ChunkTranscriptStream(chunkCtx, &richterv1.ChunkTranscriptRequest{
			LessonId: e.lessonID,
		})
		if err != nil {
			t.Fatalf("ChunkTranscriptStream call: %v", err)
		}
		var events []*richterv1.AnalysisProgressEvent
		for stream.Receive() {
			ev := stream.Msg()
			events = append(events, ev)
			t.Logf("  step=%v msg=%q", ev.Step, ev.Message)
		}
		if err := stream.Err(); err != nil {
			t.Fatalf("chunk stream error: %v", err)
		}
		if len(events) == 0 {
			t.Fatal("no events received from ChunkTranscriptStream")
		}
		last := events[len(events)-1]
		if last.Step != richterv1.AnalysisProgressStep_ANALYSIS_PROGRESS_STEP_DONE {
			msg := last.Message
			if strings.Contains(msg, "429") || strings.Contains(strings.ToLower(msg), "quota") {
				t.Skipf("Gemini API rate limit exceeded: %s", msg)
			}
			t.Fatalf("chunking failed (step=%v): %s", last.Step, msg)
		}
	}

	t.Run("ChunkTranscript/ChunksCreated", func(t *testing.T) {
		res, err := e.aiTeacher.ListLessonTranscriptChunks(ctx, &richterv1.ListLessonTranscriptChunksRequest{
			LessonId: e.lessonID,
		})
		if err != nil {
			t.Fatalf("ListLessonTranscriptChunks: %v", err)
		}
		if len(res.Chunks) == 0 {
			t.Error("expected at least one transcript chunk after chunking")
		}
		t.Logf("  %d chunks created", len(res.Chunks))
		for i, c := range res.Chunks {
			if c.Summary == "" {
				t.Errorf("chunk[%d]: empty summary", i)
			}
			if c.EndSeconds <= c.StartSeconds {
				t.Errorf("chunk[%d]: invalid time range %.1f-%.1f", i, c.StartSeconds, c.EndSeconds)
			}
		}
	})

	t.Run("ChunkTranscript/StatusIsChunksReady", func(t *testing.T) {
		res, err := e.aiTeacher.GetLessonAnalysis(ctx, &richterv1.GetLessonAnalysisRequest{LessonId: e.lessonID})
		if err != nil {
			t.Fatalf("GetLessonAnalysis: %v", err)
		}
		if res.Analysis.Status != richterv1.AnalysisStatus_ANALYSIS_STATUS_CHUNKS_READY {
			t.Errorf("status: want CHUNKS_READY, got %v", res.Analysis.Status)
		}
	})

	// ── Phase 3: GenerateQuestionsStream ──────────────────────────────────────

	t.Log("Phase 3: GenerateQuestionsStream")
	{
		genCtx, cancel := context.WithTimeout(ctx, 10*time.Minute)
		defer cancel()

		stream, err := e.aiTeacher.GenerateQuestionsStream(genCtx, &richterv1.GenerateQuestionsRequest{
			LessonId: e.lessonID,
		})
		if err != nil {
			t.Fatalf("GenerateQuestionsStream call: %v", err)
		}
		var events []*richterv1.GenerateQuestionsProgressEvent
		for stream.Receive() {
			ev := stream.Msg()
			events = append(events, ev)
			t.Logf("  step=%v msg=%q", ev.Step, ev.Message)
		}
		if err := stream.Err(); err != nil {
			t.Fatalf("stream error: %v", err)
		}
		if len(events) == 0 {
			t.Fatal("no events received from GenerateQuestionsStream")
		}
		last := events[len(events)-1]
		if last.Step != richterv1.GenerateQuestionsStep_GENERATE_QUESTIONS_STEP_DONE {
			msg := last.Message
			if strings.Contains(msg, "429") || strings.Contains(strings.ToLower(msg), "quota") {
				t.Skipf("Gemini API rate limit exceeded — try again later: %s", msg)
			}
			t.Fatalf("question generation failed (step=%v): %s", last.Step, msg)
		}
	}

	t.Run("GenerateQuestions/StatusIsDoneWithQuestions", func(t *testing.T) {
		res, err := e.aiTeacher.GetLessonAnalysis(ctx, &richterv1.GetLessonAnalysisRequest{LessonId: e.lessonID})
		if err != nil {
			t.Fatalf("GetLessonAnalysis: %v", err)
		}
		if res.Analysis == nil {
			t.Fatal("expected analysis")
		}
		if res.Analysis.Status != richterv1.AnalysisStatus_ANALYSIS_STATUS_DONE {
			t.Errorf("status: want DONE, got %v", res.Analysis.Status)
		}
		if len(res.Analysis.GetQuestions()) == 0 {
			t.Error("expected at least one question after generation")
		}
		t.Logf("  %d questions generated", len(res.Analysis.GetQuestions()))
		for i, q := range res.Analysis.GetQuestions() {
			if q.QuestionText == "" {
				t.Errorf("question[%d]: empty question text", i)
			}
			if len(q.Options) != 4 {
				t.Errorf("question[%d]: expected 4 options, got %d", i, len(q.Options))
			}
			if q.CorrectAnswer < 0 || q.CorrectAnswer >= int32(len(q.Options)) {
				t.Errorf("question[%d]: correct_answer %d out of range", i, q.CorrectAnswer)
			}
		}
	})

	t.Run("GenerateQuestions/ResumeSkipsExistingChunks", func(t *testing.T) {
		genCtx, cancel := context.WithTimeout(ctx, 5*time.Minute)
		defer cancel()

		stream, err := e.aiTeacher.GenerateQuestionsStream(genCtx, &richterv1.GenerateQuestionsRequest{
			LessonId: e.lessonID,
		})
		if err != nil {
			t.Fatalf("GenerateQuestionsStream (resume) call: %v", err)
		}
		var events []*richterv1.GenerateQuestionsProgressEvent
		for stream.Receive() {
			events = append(events, stream.Msg())
		}
		if err := stream.Err(); err != nil {
			t.Fatalf("resume stream error: %v", err)
		}
		for i, ev := range events {
			if ev.Step == richterv1.GenerateQuestionsStep_GENERATE_QUESTIONS_STEP_CHUNK {
				if !strings.Contains(ev.Message, "bỏ qua") {
					t.Errorf("resume event[%d]: expected skip but got %q", i, ev.Message)
				}
			}
		}
	})
}
