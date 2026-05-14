//go:build integ

package v1

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"connectrpc.com/connect"
	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/buf/gen/richter/v1/richterv1connect"
	"example.com/richter/internal"
	"example.com/richter/internal/db"
	"example.com/sql/gen"
	"github.com/brianvoe/gofakeit/v7"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/samber/do/v2"
)

// ── shared clients ────────────────────────────────────────────────────────────

type quizTestClients struct {
	quiz    richterv1connect.QuizServiceClient
	courses richterv1connect.CourseServiceClient
	modules richterv1connect.CourseModuleServiceClient
	lessons richterv1connect.LessonServiceClient
	orgs    richterv1connect.OrganizationServiceClient
	members richterv1connect.OrganizationMemberServiceClient
	users   richterv1connect.UserServiceClient
}

func setupQuizTestClients(t *testing.T) (quizTestClients, string) {
	t.Helper()
	url := newV1Server(t)
	adminToken := getAdminToken(t, url)
	c := quizTestClients{
		quiz:    richterv1connect.NewQuizServiceClient(httpClientWithToken(adminToken), url),
		courses: richterv1connect.NewCourseServiceClient(httpClientWithToken(adminToken), url),
		modules: richterv1connect.NewCourseModuleServiceClient(httpClientWithToken(adminToken), url),
		lessons: richterv1connect.NewLessonServiceClient(httpClientWithToken(adminToken), url),
		orgs:    richterv1connect.NewOrganizationServiceClient(httpClientWithToken(adminToken), url),
		members: richterv1connect.NewOrganizationMemberServiceClient(httpClientWithToken(adminToken), url),
		users:   richterv1connect.NewUserServiceClient(httpClientWithToken(adminToken), url),
	}
	return c, url
}

// insertTestQuestions inserts MCQ questions for a lesson directly in the DB.
func insertTestQuestions(t *testing.T, lessonID string, count int) []gen.LessonQuestion {
	t.Helper()
	pool, err := do.Invoke[*db.PostgresSvc](internal.Injector)
	if err != nil {
		t.Fatalf("get db: %v", err)
	}

	var lid pgtype.UUID
	if err := lid.Scan(lessonID); err != nil {
		t.Fatalf("parse lessonID: %v", err)
	}

	// Delete any existing questions first
	if err := db.WithConnectionExec(pool, context.Background(), func(q *gen.Queries, _ *pgxpool.Conn) error {
		return q.DeleteLessonQuestions(context.Background(), lid)
	}); err != nil {
		t.Fatalf("delete existing questions: %v", err)
	}

	questions := make([]gen.LessonQuestion, 0, count)
	for i := range count {
		optJSON, _ := json.Marshal([]string{
			gofakeit.Word(), gofakeit.Word(), gofakeit.Word(), gofakeit.Word(),
		})
		lq, err := db.WithConnection(pool, context.Background(), func(q *gen.Queries, _ *pgxpool.Conn) (gen.LessonQuestion, error) {
			return q.CreateLessonQuestion(context.Background(), gen.CreateLessonQuestionParams{
				LessonID:      lid,
				QuestionText:  gofakeit.Sentence(6),
				Options:       optJSON,
				CorrectAnswer: int32(i % 4), // cycle through 0-3
				Explanation:   pgtype.Text{String: gofakeit.Sentence(8), Valid: true},
				OrderIndex:    int32(i),
			})
		})
		if err != nil {
			t.Fatalf("create question %d: %v", i, err)
		}
		questions = append(questions, lq)
	}
	return questions
}

// ── TestQuizLifecycle ─────────────────────────────────────────────────────────

func TestQuizLifecycle(t *testing.T) {
	c, url := setupQuizTestClients(t)
	ctx := context.Background()

	// Setup: admin creates org + member + course + module + lesson
	adminRes, err := c.users.CreateUserWithRoleAndStatus(ctx, &richterv1.CreateUserWithRoleAndStatusRequest{
		Email: testEmail(), Password: testPassword(),
		FirstName: gofakeit.FirstName(), LastName: gofakeit.LastName(),
		Role: richterv1.UserRole_USER_ROLE_NORMAL, Status: richterv1.UserStatus_USER_STATUS_ACTIVE,
	})
	if err != nil {
		t.Fatalf("create owner user: %v", err)
	}
	ownerID := adminRes.User.Id

	orgRes, err := c.orgs.CreateOrganization(ctx, &richterv1.CreateOrganizationRequest{
		CreatedBy: ownerID,
		Name:      gofakeit.Company(),
		Slug:      testSlug(),
	})
	if err != nil {
		t.Fatalf("create org: %v", err)
	}
	orgID := orgRes.Organization.Id

	// Create student
	studentEmail, studentPassword, studentID := createActiveUser(t, c.users)
	_, err = c.members.AddOrganizationMember(ctx, &richterv1.AddOrganizationMemberRequest{
		OrganizationId: orgID, UserId: studentID,
		Role:   richterv1.OrganizationRole_ORGANIZATION_ROLE_STUDENT,
		Status: richterv1.MemberStatus_MEMBER_STATUS_ACTIVE,
	})
	if err != nil {
		t.Fatalf("add student: %v", err)
	}

	// Create course + module + lesson
	courseRes, err := c.courses.CreateCourse(ctx, &richterv1.CreateCourseRequest{
		OrganizationId: orgID, OwnerId: ownerID, Title: gofakeit.JobTitle(),
	})
	if err != nil {
		t.Fatalf("create course: %v", err)
	}
	moduleRes, err := c.modules.CreateCourseModule(ctx, &richterv1.CreateCourseModuleRequest{
		CourseId: courseRes.Course.Id, Title: gofakeit.JobTitle(), OrderIndex: 0,
	})
	if err != nil {
		t.Fatalf("create module: %v", err)
	}
	lessonRes, err := c.lessons.CreateLesson(ctx, &richterv1.CreateLessonRequest{
		ModuleId: moduleRes.Module.Id, Title: gofakeit.JobTitle(), OrderIndex: 0,
	})
	if err != nil {
		t.Fatalf("create lesson: %v", err)
	}
	lessonID := lessonRes.Lesson.Id

	// Insert 3 questions
	questions := insertTestQuestions(t, lessonID, 3)

	// Build correct answers: [q[0].CorrectAnswer, q[1].CorrectAnswer, q[2].CorrectAnswer]
	correctAnswers := make([]int32, len(questions))
	for i, q := range questions {
		correctAnswers[i] = q.CorrectAnswer
	}

	// Student token
	studentToken := getUserToken(t, url, studentEmail, studentPassword)
	studentQuiz := richterv1connect.NewQuizServiceClient(httpClientWithToken(studentToken), url)

	t.Run("GetMyQuizAttempt/NotAttempted", func(t *testing.T) {
		res, err := studentQuiz.GetMyQuizAttempt(ctx, &richterv1.GetMyQuizAttemptRequest{LessonId: lessonID})
		if err != nil {
			t.Fatalf("GetMyQuizAttempt: %v", err)
		}
		if res.Attempt != nil {
			t.Error("expected nil attempt before submission")
		}
	})

	t.Run("SubmitQuiz/AllCorrect", func(t *testing.T) {
		res, err := studentQuiz.SubmitQuiz(ctx, &richterv1.SubmitQuizRequest{
			LessonId: lessonID,
			Answers:  correctAnswers,
		})
		if err != nil {
			t.Fatalf("SubmitQuiz: %v", err)
		}
		if res.Attempt == nil {
			t.Fatal("expected attempt in response")
		}
		if res.Attempt.Score != int32(len(questions)) {
			t.Errorf("score: want %d, got %d", len(questions), res.Attempt.Score)
		}
		if res.Attempt.Total != int32(len(questions)) {
			t.Errorf("total: want %d, got %d", len(questions), res.Attempt.Total)
		}
	})

	t.Run("GetMyQuizAttempt/AfterSubmission", func(t *testing.T) {
		res, err := studentQuiz.GetMyQuizAttempt(ctx, &richterv1.GetMyQuizAttemptRequest{LessonId: lessonID})
		if err != nil {
			t.Fatalf("GetMyQuizAttempt: %v", err)
		}
		if res.Attempt == nil {
			t.Fatal("expected attempt after submission")
		}
		if res.Attempt.Score != int32(len(questions)) {
			t.Errorf("score: want %d, got %d", len(questions), res.Attempt.Score)
		}
	})

	t.Run("SubmitQuiz/Retake/AllWrong", func(t *testing.T) {
		// Submit with all wrong answers (pick wrong option for each)
		wrongAnswers := make([]int32, len(questions))
		for i, q := range questions {
			wrongAnswers[i] = (q.CorrectAnswer + 1) % 4
		}
		res, err := studentQuiz.SubmitQuiz(ctx, &richterv1.SubmitQuizRequest{
			LessonId: lessonID,
			Answers:  wrongAnswers,
		})
		if err != nil {
			t.Fatalf("SubmitQuiz retake: %v", err)
		}
		if res.Attempt.Score != 0 {
			t.Errorf("expected score=0, got %d", res.Attempt.Score)
		}
	})

	t.Run("ListLessonAttempts/Admin", func(t *testing.T) {
		res, err := c.quiz.ListLessonAttempts(ctx, &richterv1.ListLessonAttemptsRequest{
			LessonId: lessonID, Limit: 10, Offset: 0,
		})
		if err != nil {
			t.Fatalf("ListLessonAttempts: %v", err)
		}
		if res.Total == 0 {
			t.Error("expected at least 1 attempt in listing")
		}
		found := false
		for _, a := range res.Attempts {
			if a.UserId == studentID {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("student %s not found in attempts list", studentID)
		}
	})
}

// ── TestQuizValidation ────────────────────────────────────────────────────────

func TestQuizValidation(t *testing.T) {
	c, _ := setupQuizTestClients(t)
	ctx := context.Background()

	t.Run("SubmitQuiz/NoAnswers", func(t *testing.T) {
		assertCode(t, func() error {
			_, e := c.quiz.SubmitQuiz(ctx, &richterv1.SubmitQuizRequest{LessonId: gofakeit.UUID(), Answers: nil})
			return e
		}(), connect.CodeInvalidArgument)
	})

	t.Run("SubmitQuiz/InvalidLessonID", func(t *testing.T) {
		assertCode(t, func() error {
			_, e := c.quiz.SubmitQuiz(ctx, &richterv1.SubmitQuizRequest{LessonId: "not-a-uuid", Answers: []int32{0}})
			return e
		}(), connect.CodeInvalidArgument)
	})

	t.Run("SubmitQuiz/LessonNoQuestions", func(t *testing.T) {
		// Create a lesson with no questions
		ownerRes, _ := c.users.CreateUserWithRoleAndStatus(ctx, &richterv1.CreateUserWithRoleAndStatusRequest{
			Email: testEmail(), Password: testPassword(),
			FirstName: gofakeit.FirstName(), LastName: gofakeit.LastName(),
			Role: richterv1.UserRole_USER_ROLE_NORMAL, Status: richterv1.UserStatus_USER_STATUS_ACTIVE,
		})
		orgRes, _ := c.orgs.CreateOrganization(ctx, &richterv1.CreateOrganizationRequest{
			CreatedBy: ownerRes.User.Id, Name: gofakeit.Company(), Slug: testSlug(),
		})
		courseRes, _ := c.courses.CreateCourse(ctx, &richterv1.CreateCourseRequest{
			OrganizationId: orgRes.Organization.Id, OwnerId: ownerRes.User.Id, Title: gofakeit.JobTitle(),
		})
		modRes, _ := c.modules.CreateCourseModule(ctx, &richterv1.CreateCourseModuleRequest{
			CourseId: courseRes.Course.Id, Title: gofakeit.JobTitle(), OrderIndex: 0,
		})
		lessonRes, _ := c.lessons.CreateLesson(ctx, &richterv1.CreateLessonRequest{
			ModuleId: modRes.Module.Id, Title: gofakeit.JobTitle(), OrderIndex: 0,
		})
		assertCode(t, func() error {
			_, e := c.quiz.SubmitQuiz(ctx, &richterv1.SubmitQuizRequest{
				LessonId: lessonRes.Lesson.Id, Answers: []int32{0},
			})
			return e
		}(), connect.CodeFailedPrecondition)
	})
}

// ── TestQuizAuthz ─────────────────────────────────────────────────────────────

func TestQuizAuthz(t *testing.T) {
	c, url := setupQuizTestClients(t)
	ctx := context.Background()

	// Setup
	ownerRes, _ := c.users.CreateUserWithRoleAndStatus(ctx, &richterv1.CreateUserWithRoleAndStatusRequest{
		Email: testEmail(), Password: testPassword(),
		FirstName: gofakeit.FirstName(), LastName: gofakeit.LastName(),
		Role: richterv1.UserRole_USER_ROLE_NORMAL, Status: richterv1.UserStatus_USER_STATUS_ACTIVE,
	})
	orgRes, _ := c.orgs.CreateOrganization(ctx, &richterv1.CreateOrganizationRequest{
		CreatedBy: ownerRes.User.Id, Name: gofakeit.Company(), Slug: testSlug(),
	})
	orgID := orgRes.Organization.Id
	courseRes, _ := c.courses.CreateCourse(ctx, &richterv1.CreateCourseRequest{
		OrganizationId: orgID, OwnerId: ownerRes.User.Id, Title: gofakeit.JobTitle(),
	})
	modRes, _ := c.modules.CreateCourseModule(ctx, &richterv1.CreateCourseModuleRequest{
		CourseId: courseRes.Course.Id, Title: gofakeit.JobTitle(), OrderIndex: 0,
	})
	lessonRes, _ := c.lessons.CreateLesson(ctx, &richterv1.CreateLessonRequest{
		ModuleId: modRes.Module.Id, Title: gofakeit.JobTitle(), OrderIndex: 0,
	})
	lessonID := lessonRes.Lesson.Id
	insertTestQuestions(t, lessonID, 2)

	// Create student (member), teacher (member), and non-member
	studentEmail, studentPassword, studentID := createActiveUser(t, c.users)
	_, _ = c.members.AddOrganizationMember(ctx, &richterv1.AddOrganizationMemberRequest{
		OrganizationId: orgID, UserId: studentID,
		Role:   richterv1.OrganizationRole_ORGANIZATION_ROLE_STUDENT,
		Status: richterv1.MemberStatus_MEMBER_STATUS_ACTIVE,
	})
	teacherEmail, teacherPassword, teacherID := createActiveUser(t, c.users)
	_, _ = c.members.AddOrganizationMember(ctx, &richterv1.AddOrganizationMemberRequest{
		OrganizationId: orgID, UserId: teacherID,
		Role:   richterv1.OrganizationRole_ORGANIZATION_ROLE_TEACHER,
		Status: richterv1.MemberStatus_MEMBER_STATUS_ACTIVE,
	})
	nonMemberEmail, nonMemberPassword, _ := createActiveUser(t, c.users)

	anonQuiz := richterv1connect.NewQuizServiceClient(http.DefaultClient, url)
	studentToken := getUserToken(t, url, studentEmail, studentPassword)
	studentQuiz := richterv1connect.NewQuizServiceClient(httpClientWithToken(studentToken), url)
	teacherToken := getUserToken(t, url, teacherEmail, teacherPassword)
	teacherQuiz := richterv1connect.NewQuizServiceClient(httpClientWithToken(teacherToken), url)
	nonMemberToken := getUserToken(t, url, nonMemberEmail, nonMemberPassword)
	nonMemberQuiz := richterv1connect.NewQuizServiceClient(httpClientWithToken(nonMemberToken), url)

	// SubmitQuiz
	t.Run("SubmitQuiz", func(t *testing.T) {
		req := &richterv1.SubmitQuizRequest{LessonId: lessonID, Answers: []int32{0, 0}}
		t.Run("Anon/Unauthenticated", func(t *testing.T) {
			assertCode(t, func() error { _, e := anonQuiz.SubmitQuiz(ctx, req); return e }(), connect.CodeUnauthenticated)
		})
		t.Run("NonMember/PermissionDenied", func(t *testing.T) {
			assertCode(t, func() error { _, e := nonMemberQuiz.SubmitQuiz(ctx, req); return e }(), connect.CodePermissionDenied)
		})
		t.Run("Student/OK", func(t *testing.T) {
			if _, err := studentQuiz.SubmitQuiz(ctx, req); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
	})

	// GetMyQuizAttempt
	t.Run("GetMyQuizAttempt", func(t *testing.T) {
		req := &richterv1.GetMyQuizAttemptRequest{LessonId: lessonID}
		t.Run("Anon/Unauthenticated", func(t *testing.T) {
			assertCode(t, func() error { _, e := anonQuiz.GetMyQuizAttempt(ctx, req); return e }(), connect.CodeUnauthenticated)
		})
		t.Run("NonMember/PermissionDenied", func(t *testing.T) {
			assertCode(t, func() error { _, e := nonMemberQuiz.GetMyQuizAttempt(ctx, req); return e }(), connect.CodePermissionDenied)
		})
		t.Run("Student/OK", func(t *testing.T) {
			if _, err := studentQuiz.GetMyQuizAttempt(ctx, req); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
	})

	// ListLessonAttempts
	t.Run("ListLessonAttempts", func(t *testing.T) {
		req := &richterv1.ListLessonAttemptsRequest{LessonId: lessonID, Limit: 10, Offset: 0}
		t.Run("Anon/Unauthenticated", func(t *testing.T) {
			assertCode(t, func() error { _, e := anonQuiz.ListLessonAttempts(ctx, req); return e }(), connect.CodeUnauthenticated)
		})
		t.Run("Student/PermissionDenied", func(t *testing.T) {
			assertCode(t, func() error { _, e := studentQuiz.ListLessonAttempts(ctx, req); return e }(), connect.CodePermissionDenied)
		})
		t.Run("Teacher/OK", func(t *testing.T) {
			if _, err := teacherQuiz.ListLessonAttempts(ctx, req); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
		t.Run("Admin/OK", func(t *testing.T) {
			if _, err := c.quiz.ListLessonAttempts(ctx, req); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
	})
}
