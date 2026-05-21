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

type interactionsTestClients struct {
	interactions richterv1connect.InteractionServiceClient
	courses      richterv1connect.CourseServiceClient
	modules      richterv1connect.CourseModuleServiceClient
	lessons      richterv1connect.LessonServiceClient
	orgs         richterv1connect.OrganizationServiceClient
	members      richterv1connect.OrganizationMemberServiceClient
	users        richterv1connect.UserServiceClient
}

func setupInteractionsTestClients(t *testing.T) (interactionsTestClients, string) {
	t.Helper()
	url := newV1Server(t)
	adminToken := getAdminToken(t, url)
	c := interactionsTestClients{
		interactions: richterv1connect.NewInteractionServiceClient(httpClientWithToken(adminToken), url),
		courses:      richterv1connect.NewCourseServiceClient(httpClientWithToken(adminToken), url),
		modules:      richterv1connect.NewCourseModuleServiceClient(httpClientWithToken(adminToken), url),
		lessons:      richterv1connect.NewLessonServiceClient(httpClientWithToken(adminToken), url),
		orgs:         richterv1connect.NewOrganizationServiceClient(httpClientWithToken(adminToken), url),
		members:      richterv1connect.NewOrganizationMemberServiceClient(httpClientWithToken(adminToken), url),
		users:        richterv1connect.NewUserServiceClient(httpClientWithToken(adminToken), url),
	}
	return c, url
}

// insertTestInteractions inserts MCQ interactions for a lesson directly in the DB.
// Returns interaction IDs in order.
func insertTestInteractions(t *testing.T, lessonID string, count int) []gen.LessonInteraction {
	t.Helper()
	pool, err := do.Invoke[*db.PostgresSvc](internal.Injector)
	if err != nil {
		t.Fatalf("get db: %v", err)
	}

	var lid pgtype.UUID
	if err := lid.Scan(lessonID); err != nil {
		t.Fatalf("parse lessonID: %v", err)
	}

	if err := db.WithConnectionExec(pool, context.Background(), func(q *gen.Queries, _ *pgxpool.Conn) error {
		return q.DeleteLessonInteractionsByLesson(context.Background(), lid)
	}); err != nil {
		t.Fatalf("delete existing interactions: %v", err)
	}

	interactions := make([]gen.LessonInteraction, 0, count)
	for i := range count {
		correctAnswer := i % 4
		configJSON, _ := json.Marshal(struct {
			Options       []string `json:"options"`
			CorrectAnswer int      `json:"correct_answer"`
		}{
			Options:       []string{gofakeit.Word(), gofakeit.Word(), gofakeit.Word(), gofakeit.Word()},
			CorrectAnswer: correctAnswer,
		})
		li, err := db.WithConnection(pool, context.Background(), func(q *gen.Queries, _ *pgxpool.Conn) (gen.LessonInteraction, error) {
			return q.InsertLessonInteraction(context.Background(), gen.InsertLessonInteractionParams{
				LessonID:     lid,
				ChunkID:      pgtype.UUID{},
				Kind:         "mcq",
				StartSeconds: float32(i * 60),
				OrderIndex:   int32(i),
				Prompt:       gofakeit.Sentence(6),
				Explanation:  gofakeit.Sentence(8),
				Config:       configJSON,
				MaxScore:     1.0,
				GeneratedBy:  "test",
			})
		})
		if err != nil {
			t.Fatalf("create interaction %d: %v", i, err)
		}
		interactions = append(interactions, li)
	}
	return interactions
}

// buildResponses constructs AttemptResponseInput slice with the given selected options.
func buildResponses(interactions []gen.LessonInteraction, selected []int32) []*richterv1.AttemptResponseInput {
	resps := make([]*richterv1.AttemptResponseInput, 0, len(interactions))
	for i, li := range interactions {
		sel := int32(0)
		if i < len(selected) {
			sel = selected[i]
		}
		resps = append(resps, &richterv1.AttemptResponseInput{
			InteractionId: li.ID.String(),
			Response:      &richterv1.AttemptResponseInput_McqSelected{McqSelected: sel},
		})
	}
	return resps
}

// correctAnswers extracts the correct answer index for each interaction.
func correctAnswers(interactions []gen.LessonInteraction) []int32 {
	answers := make([]int32, len(interactions))
	for i, li := range interactions {
		var cfg struct {
			CorrectAnswer int `json:"correct_answer"`
		}
		_ = json.Unmarshal(li.Config, &cfg)
		answers[i] = int32(cfg.CorrectAnswer)
	}
	return answers
}

// ── TestInteractionsLifecycle ─────────────────────────────────────────────────

func TestInteractionsLifecycle(t *testing.T) {
	c, url := setupInteractionsTestClients(t)
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

	// Insert 3 interactions
	ints := insertTestInteractions(t, lessonID, 3)
	correct := correctAnswers(ints)

	// Student token
	studentToken := getUserToken(t, url, studentEmail, studentPassword)
	studentInteractions := richterv1connect.NewInteractionServiceClient(httpClientWithToken(studentToken), url)

	t.Run("GetMyAttempt/NotAttempted", func(t *testing.T) {
		res, err := studentInteractions.GetMyAttempt(ctx, &richterv1.GetMyAttemptRequest{LessonId: lessonID})
		if err != nil {
			t.Fatalf("GetMyAttempt: %v", err)
		}
		if res.Attempt != nil {
			t.Error("expected nil attempt before submission")
		}
	})

	t.Run("SubmitAttempt/AllCorrect", func(t *testing.T) {
		res, err := studentInteractions.SubmitAttempt(ctx, &richterv1.SubmitAttemptRequest{
			LessonId:  lessonID,
			Responses: buildResponses(ints, correct),
		})
		if err != nil {
			t.Fatalf("SubmitAttempt: %v", err)
		}
		if res.Attempt == nil {
			t.Fatal("expected attempt in response")
		}
		if res.Attempt.TotalScore != float32(len(ints)) {
			t.Errorf("total_score: want %d, got %v", len(ints), res.Attempt.TotalScore)
		}
		if res.Attempt.MaxScore != float32(len(ints)) {
			t.Errorf("max_score: want %d, got %v", len(ints), res.Attempt.MaxScore)
		}
	})

	t.Run("GetMyAttempt/AfterSubmission", func(t *testing.T) {
		res, err := studentInteractions.GetMyAttempt(ctx, &richterv1.GetMyAttemptRequest{LessonId: lessonID})
		if err != nil {
			t.Fatalf("GetMyAttempt: %v", err)
		}
		if res.Attempt == nil {
			t.Fatal("expected attempt after submission")
		}
		if res.Attempt.TotalScore != float32(len(ints)) {
			t.Errorf("total_score: want %d, got %v", len(ints), res.Attempt.TotalScore)
		}
	})

	t.Run("SubmitAttempt/Retake/AllWrong", func(t *testing.T) {
		// Pick wrong option for each interaction
		wrong := make([]int32, len(ints))
		for i := range ints {
			wrong[i] = (correct[i] + 1) % 4
		}
		res, err := studentInteractions.SubmitAttempt(ctx, &richterv1.SubmitAttemptRequest{
			LessonId:  lessonID,
			Responses: buildResponses(ints, wrong),
		})
		if err != nil {
			t.Fatalf("SubmitAttempt retake: %v", err)
		}
		if res.Attempt.TotalScore != 0 {
			t.Errorf("expected total_score=0, got %v", res.Attempt.TotalScore)
		}
	})

	t.Run("ListAttempts/Admin", func(t *testing.T) {
		res, err := c.interactions.ListAttempts(ctx, &richterv1.ListAttemptsRequest{
			LessonId: lessonID, Limit: 10, Offset: 0,
		})
		if err != nil {
			t.Fatalf("ListAttempts: %v", err)
		}
		if res.Total != 1 {
			t.Errorf("expected exactly 1 attempt (upsert per student+lesson), got %d", res.Total)
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

// ── TestInteractionsValidation ────────────────────────────────────────────────

func TestInteractionsValidation(t *testing.T) {
	c, _ := setupInteractionsTestClients(t)
	ctx := context.Background()

	t.Run("SubmitAttempt/NoResponses", func(t *testing.T) {
		assertCode(t, func() error {
			_, e := c.interactions.SubmitAttempt(ctx, &richterv1.SubmitAttemptRequest{LessonId: gofakeit.UUID(), Responses: nil})
			return e
		}(), connect.CodeInvalidArgument)
	})

	t.Run("SubmitAttempt/InvalidLessonID", func(t *testing.T) {
		assertCode(t, func() error {
			_, e := c.interactions.SubmitAttempt(ctx, &richterv1.SubmitAttemptRequest{
				LessonId: "not-a-uuid",
				Responses: []*richterv1.AttemptResponseInput{
					{InteractionId: gofakeit.UUID(), Response: &richterv1.AttemptResponseInput_McqSelected{McqSelected: 0}},
				},
			})
			return e
		}(), connect.CodeInvalidArgument)
	})

	t.Run("SubmitAttempt/LessonNoInteractions", func(t *testing.T) {
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
			_, e := c.interactions.SubmitAttempt(ctx, &richterv1.SubmitAttemptRequest{
				LessonId: lessonRes.Lesson.Id,
				Responses: []*richterv1.AttemptResponseInput{
					{InteractionId: gofakeit.UUID(), Response: &richterv1.AttemptResponseInput_McqSelected{McqSelected: 0}},
				},
			})
			return e
		}(), connect.CodeFailedPrecondition)
	})
}

// ── TestInteractionsAuthz ─────────────────────────────────────────────────────

func TestInteractionsAuthz(t *testing.T) {
	c, url := setupInteractionsTestClients(t)
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
	ints := insertTestInteractions(t, lessonID, 2)

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

	anonIA := richterv1connect.NewInteractionServiceClient(http.DefaultClient, url)
	studentToken := getUserToken(t, url, studentEmail, studentPassword)
	studentIA := richterv1connect.NewInteractionServiceClient(httpClientWithToken(studentToken), url)
	teacherToken := getUserToken(t, url, teacherEmail, teacherPassword)
	teacherIA := richterv1connect.NewInteractionServiceClient(httpClientWithToken(teacherToken), url)
	nonMemberToken := getUserToken(t, url, nonMemberEmail, nonMemberPassword)
	nonMemberIA := richterv1connect.NewInteractionServiceClient(httpClientWithToken(nonMemberToken), url)

	submitReq := &richterv1.SubmitAttemptRequest{
		LessonId:  lessonID,
		Responses: buildResponses(ints, []int32{0, 0}),
	}

	// SubmitAttempt
	t.Run("SubmitAttempt", func(t *testing.T) {
		t.Run("Anon/Unauthenticated", func(t *testing.T) {
			assertCode(t, func() error { _, e := anonIA.SubmitAttempt(ctx, submitReq); return e }(), connect.CodeUnauthenticated)
		})
		t.Run("NonMember/PermissionDenied", func(t *testing.T) {
			assertCode(t, func() error { _, e := nonMemberIA.SubmitAttempt(ctx, submitReq); return e }(), connect.CodePermissionDenied)
		})
		t.Run("Student/OK", func(t *testing.T) {
			if _, err := studentIA.SubmitAttempt(ctx, submitReq); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
	})

	// GetMyAttempt
	t.Run("GetMyAttempt", func(t *testing.T) {
		req := &richterv1.GetMyAttemptRequest{LessonId: lessonID}
		t.Run("Anon/Unauthenticated", func(t *testing.T) {
			assertCode(t, func() error { _, e := anonIA.GetMyAttempt(ctx, req); return e }(), connect.CodeUnauthenticated)
		})
		t.Run("NonMember/PermissionDenied", func(t *testing.T) {
			assertCode(t, func() error { _, e := nonMemberIA.GetMyAttempt(ctx, req); return e }(), connect.CodePermissionDenied)
		})
		t.Run("Student/OK", func(t *testing.T) {
			if _, err := studentIA.GetMyAttempt(ctx, req); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
	})

	// ListAttempts
	t.Run("ListAttempts", func(t *testing.T) {
		req := &richterv1.ListAttemptsRequest{LessonId: lessonID, Limit: 10, Offset: 0}
		t.Run("Anon/Unauthenticated", func(t *testing.T) {
			assertCode(t, func() error { _, e := anonIA.ListAttempts(ctx, req); return e }(), connect.CodeUnauthenticated)
		})
		t.Run("Student/PermissionDenied", func(t *testing.T) {
			assertCode(t, func() error { _, e := studentIA.ListAttempts(ctx, req); return e }(), connect.CodePermissionDenied)
		})
		t.Run("Teacher/OK", func(t *testing.T) {
			if _, err := teacherIA.ListAttempts(ctx, req); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
		t.Run("Admin/OK", func(t *testing.T) {
			if _, err := c.interactions.ListAttempts(ctx, req); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
	})
}

// ── TestFillBlankInteractions ─────────────────────────────────────────────────

// insertFillBlankInteraction inserts one fill_blank interaction directly in the DB.
func insertFillBlankInteraction(t *testing.T, lessonID string, template string, blanks []struct{ Accepted []string }) gen.LessonInteraction {
	t.Helper()
	pool, err := do.Invoke[*db.PostgresSvc](internal.Injector)
	if err != nil {
		t.Fatalf("get db: %v", err)
	}
	var lid pgtype.UUID
	if err := lid.Scan(lessonID); err != nil {
		t.Fatalf("parse lessonID: %v", err)
	}
	type blankJSON struct {
		Accepted []string `json:"accepted"`
	}
	type cfgJSON struct {
		Template string      `json:"template"`
		Blanks   []blankJSON `json:"blanks"`
	}
	b := make([]blankJSON, len(blanks))
	for i, bl := range blanks {
		b[i] = blankJSON{Accepted: bl.Accepted}
	}
	configJSON, _ := json.Marshal(cfgJSON{Template: template, Blanks: b})
	li, err := db.WithConnection(pool, context.Background(), func(q *gen.Queries, _ *pgxpool.Conn) (gen.LessonInteraction, error) {
		return q.InsertLessonInteraction(context.Background(), gen.InsertLessonInteractionParams{
			LessonID:     lid,
			ChunkID:      pgtype.UUID{},
			Kind:         "fill_blank",
			StartSeconds: 60.0,
			OrderIndex:   0,
			Prompt:       "Complete the sentence:",
			Explanation:  "Key concept test",
			Config:       configJSON,
			MaxScore:     float32(len(blanks)),
			GeneratedBy:  "test",
		})
	})
	if err != nil {
		t.Fatalf("insert fill_blank interaction: %v", err)
	}
	return li
}

func TestFillBlankInteractions(t *testing.T) {
	c, url := setupInteractionsTestClients(t)
	ctx := context.Background()

	// Setup: org + course + module + lesson
	userRes, err := c.users.CreateUserWithRoleAndStatus(ctx, &richterv1.CreateUserWithRoleAndStatusRequest{
		Email: testEmail(), Password: testPassword(),
		FirstName: gofakeit.FirstName(), LastName: gofakeit.LastName(),
		Role: richterv1.UserRole_USER_ROLE_NORMAL, Status: richterv1.UserStatus_USER_STATUS_ACTIVE,
	})
	if err != nil {
		t.Fatalf("create owner: %v", err)
	}
	orgRes, err := c.orgs.CreateOrganization(ctx, &richterv1.CreateOrganizationRequest{
		CreatedBy: userRes.User.Id, Name: gofakeit.Company(), Slug: testSlug(),
	})
	if err != nil {
		t.Fatalf("create org: %v", err)
	}
	courseRes, err := c.courses.CreateCourse(ctx, &richterv1.CreateCourseRequest{
		OrganizationId: orgRes.Organization.Id, OwnerId: userRes.User.Id, Title: gofakeit.JobTitle(),
	})
	if err != nil {
		t.Fatalf("create course: %v", err)
	}
	modRes, err := c.modules.CreateCourseModule(ctx, &richterv1.CreateCourseModuleRequest{
		CourseId: courseRes.Course.Id, Title: gofakeit.JobTitle(), OrderIndex: 0,
	})
	if err != nil {
		t.Fatalf("create module: %v", err)
	}
	lessonRes, err := c.lessons.CreateLesson(ctx, &richterv1.CreateLessonRequest{
		ModuleId: modRes.Module.Id, Title: gofakeit.JobTitle(), OrderIndex: 0,
	})
	if err != nil {
		t.Fatalf("create lesson: %v", err)
	}
	lessonID := lessonRes.Lesson.Id

	// Create student
	studentEmail, studentPassword, studentID := createActiveUser(t, c.users)
	_, err = c.members.AddOrganizationMember(ctx, &richterv1.AddOrganizationMemberRequest{
		OrganizationId: orgRes.Organization.Id, UserId: studentID,
		Role: richterv1.OrganizationRole_ORGANIZATION_ROLE_STUDENT, Status: richterv1.MemberStatus_MEMBER_STATUS_ACTIVE,
	})
	if err != nil {
		t.Fatalf("add student: %v", err)
	}

	// Insert 2-blank fill_blank interaction: template "Energy cannot be {{0}}, only {{1}}."
	fi := insertFillBlankInteraction(t, lessonID, "Energy cannot be {{0}}, only {{1}}.", []struct{ Accepted []string }{
		{Accepted: []string{"created", "destroyed"}},
		{Accepted: []string{"transformed", "converted"}},
	})
	studentToken := getUserToken(t, url, studentEmail, studentPassword)
	studentIA := richterv1connect.NewInteractionServiceClient(httpClientWithToken(studentToken), url)

	t.Run("Grade/AllCorrect", func(t *testing.T) {
		// "created" matches blank[0], "transformed" matches blank[1]
		req := &richterv1.SubmitAttemptRequest{
			LessonId: lessonID,
			Responses: []*richterv1.AttemptResponseInput{{
				InteractionId: fi.ID.String(),
				Response: &richterv1.AttemptResponseInput_FillBlank{
					FillBlank: &richterv1.FillBlankResponse{Answers: []string{"created", "transformed"}},
				},
			}},
		}
		res, err := studentIA.SubmitAttempt(ctx, req)
		if err != nil {
			t.Fatalf("submit attempt: %v", err)
		}
		attempt := res.Attempt
		if attempt.TotalScore != 2.0 {
			t.Errorf("expected total score 2.0, got %v", attempt.TotalScore)
		}
		if attempt.MaxScore != 2.0 {
			t.Errorf("expected max score 2.0, got %v", attempt.MaxScore)
		}
	})

	t.Run("Grade/PartialCredit", func(t *testing.T) {
		// "created" correct, "wrong" incorrect
		req := &richterv1.SubmitAttemptRequest{
			LessonId: lessonID,
			Responses: []*richterv1.AttemptResponseInput{{
				InteractionId: fi.ID.String(),
				Response: &richterv1.AttemptResponseInput_FillBlank{
					FillBlank: &richterv1.FillBlankResponse{Answers: []string{"created", "wrong"}},
				},
			}},
		}
		res, err := studentIA.SubmitAttempt(ctx, req)
		if err != nil {
			t.Fatalf("submit attempt: %v", err)
		}
		attempt := res.Attempt
		if attempt.TotalScore != 1.0 {
			t.Errorf("expected total score 1.0, got %v", attempt.TotalScore)
		}
	})

	t.Run("Grade/CaseInsensitive", func(t *testing.T) {
		// "CREATED" should match "created" (case-insensitive by default)
		req := &richterv1.SubmitAttemptRequest{
			LessonId: lessonID,
			Responses: []*richterv1.AttemptResponseInput{{
				InteractionId: fi.ID.String(),
				Response: &richterv1.AttemptResponseInput_FillBlank{
					FillBlank: &richterv1.FillBlankResponse{Answers: []string{"CREATED", "TRANSFORMED"}},
				},
			}},
		}
		res, err := studentIA.SubmitAttempt(ctx, req)
		if err != nil {
			t.Fatalf("submit attempt: %v", err)
		}
		attempt := res.Attempt
		if attempt.TotalScore != 2.0 {
			t.Errorf("expected 2.0 (case-insensitive), got %v", attempt.TotalScore)
		}
	})

	t.Run("GetMyAttempt/ReturnsFillBlankResponse", func(t *testing.T) {
		// Submit first so there's an attempt
		_, _ = studentIA.SubmitAttempt(ctx, &richterv1.SubmitAttemptRequest{
			LessonId: lessonID,
			Responses: []*richterv1.AttemptResponseInput{{
				InteractionId: fi.ID.String(),
				Response: &richterv1.AttemptResponseInput_FillBlank{
					FillBlank: &richterv1.FillBlankResponse{Answers: []string{"created", "transformed"}},
				},
			}},
		})
		res, err := studentIA.GetMyAttempt(ctx, &richterv1.GetMyAttemptRequest{LessonId: lessonID})
		if err != nil {
			t.Fatalf("get attempt: %v", err)
		}
		attempt := res.Attempt
		if len(attempt.Responses) != 1 {
			t.Fatalf("expected 1 response, got %d", len(attempt.Responses))
		}
		r := attempt.Responses[0]
		fb, ok := r.Response.(*richterv1.LessonAttemptResponse_FillBlank)
		if !ok {
			t.Fatalf("expected FillBlankResponse, got %T", r.Response)
		}
		if len(fb.FillBlank.Answers) != 2 {
			t.Errorf("expected 2 answers, got %d", len(fb.FillBlank.Answers))
		}
	})
}

// ── TestListeningInteractionLifecycle ─────────────────────────────────────────

func TestListeningInteractionLifecycle(t *testing.T) {
	c, url := setupInteractionsTestClients(t)
	ctx := context.Background()

	ownerRes, err := c.users.CreateUserWithRoleAndStatus(ctx, &richterv1.CreateUserWithRoleAndStatusRequest{
		Email: testEmail(), Password: testPassword(),
		FirstName: gofakeit.FirstName(), LastName: gofakeit.LastName(),
		Role: richterv1.UserRole_USER_ROLE_NORMAL, Status: richterv1.UserStatus_USER_STATUS_ACTIVE,
	})
	if err != nil {
		t.Fatalf("create owner: %v", err)
	}
	orgRes, err := c.orgs.CreateOrganization(ctx, &richterv1.CreateOrganizationRequest{
		CreatedBy: ownerRes.User.Id, Name: gofakeit.Company(), Slug: testSlug(),
	})
	if err != nil {
		t.Fatalf("create org: %v", err)
	}
	orgID := orgRes.Organization.Id
	studentEmail, studentPassword, studentID := createActiveUser(t, c.users)
	_, err = c.members.AddOrganizationMember(ctx, &richterv1.AddOrganizationMemberRequest{
		OrganizationId: orgID, UserId: studentID,
		Role:   richterv1.OrganizationRole_ORGANIZATION_ROLE_STUDENT,
		Status: richterv1.MemberStatus_MEMBER_STATUS_ACTIVE,
	})
	if err != nil {
		t.Fatalf("add student: %v", err)
	}
	courseRes, _ := c.courses.CreateCourse(ctx, &richterv1.CreateCourseRequest{OrganizationId: orgID, OwnerId: ownerRes.User.Id, Title: gofakeit.JobTitle()})
	moduleRes, _ := c.modules.CreateCourseModule(ctx, &richterv1.CreateCourseModuleRequest{CourseId: courseRes.Course.Id, Title: gofakeit.JobTitle(), OrderIndex: 0})
	lessonRes, _ := c.lessons.CreateLesson(ctx, &richterv1.CreateLessonRequest{ModuleId: moduleRes.Module.Id, Title: gofakeit.JobTitle(), OrderIndex: 0})
	lessonID := lessonRes.Lesson.Id

	// Create LISTENING (comprehension, 2 nested MCQs)
	createRes, err := c.interactions.CreateManualInteraction(ctx, &richterv1.CreateManualInteractionRequest{
		LessonId:     lessonID,
		Prompt:       "Nghe đoạn audio và trả lời câu hỏi",
		StartSeconds: 0,
		Config: &richterv1.CreateManualInteractionRequest_Listening{
			Listening: &richterv1.ListeningConfig{
				AudioObjectKey: "lessons/test/audio.mp3",
				Mode:           richterv1.ListeningMode_LISTENING_MODE_COMPREHENSION,
				ComprehensionQuestions: []*richterv1.McqConfig{
					{Options: []*richterv1.McqOption{{Text: "A"}, {Text: "B"}, {Text: "C"}, {Text: "D"}}, CorrectAnswer: 1},
					{Options: []*richterv1.McqOption{{Text: "P"}, {Text: "Q"}, {Text: "R"}, {Text: "S"}}, CorrectAnswer: 3},
				},
			},
		},
	})
	if err != nil {
		t.Fatalf("create listening interaction: %v", err)
	}
	interactionID := createRes.Interaction.Id
	if createRes.Interaction.Kind != richterv1.InteractionKind_INTERACTION_KIND_LISTENING {
		t.Errorf("kind: want LISTENING, got %v", createRes.Interaction.Kind)
	}

	// Student submits: correct answers [1, 3]
	studentToken := getUserToken(t, url, studentEmail, studentPassword)
	studentIA := richterv1connect.NewInteractionServiceClient(httpClientWithToken(studentToken), url)

	submitRes, err := studentIA.SubmitAttempt(ctx, &richterv1.SubmitAttemptRequest{
		LessonId: lessonID,
		Responses: []*richterv1.AttemptResponseInput{{
			InteractionId: interactionID,
			Response: &richterv1.AttemptResponseInput_Listening{
				Listening: &richterv1.ListeningResponse{ComprehensionAnswers: []int32{1, 3}},
			},
		}},
	})
	if err != nil {
		t.Fatalf("submit attempt: %v", err)
	}
	if submitRes.Attempt.TotalScore != 2.0 || submitRes.Attempt.MaxScore != 2.0 {
		t.Errorf("scores: want 2/2, got %v/%v", submitRes.Attempt.TotalScore, submitRes.Attempt.MaxScore)
	}

	// Verify round-trip via GetMyAttempt
	getRes, err := studentIA.GetMyAttempt(ctx, &richterv1.GetMyAttemptRequest{LessonId: lessonID})
	if err != nil {
		t.Fatalf("GetMyAttempt: %v", err)
	}
	if len(getRes.Attempt.Responses) != 1 {
		t.Fatalf("expected 1 response, got %d", len(getRes.Attempt.Responses))
	}
	lr, ok := getRes.Attempt.Responses[0].Response.(*richterv1.LessonAttemptResponse_Listening)
	if !ok {
		t.Fatalf("expected ListeningResponse, got %T", getRes.Attempt.Responses[0].Response)
	}
	if len(lr.Listening.ComprehensionAnswers) != 2 {
		t.Errorf("expected 2 comprehension answers, got %d", len(lr.Listening.ComprehensionAnswers))
	}
}

// ── TestReadingInteractionLifecycle ───────────────────────────────────────────

func TestReadingInteractionLifecycle(t *testing.T) {
	c, url := setupInteractionsTestClients(t)
	ctx := context.Background()

	ownerRes, err := c.users.CreateUserWithRoleAndStatus(ctx, &richterv1.CreateUserWithRoleAndStatusRequest{
		Email: testEmail(), Password: testPassword(),
		FirstName: gofakeit.FirstName(), LastName: gofakeit.LastName(),
		Role: richterv1.UserRole_USER_ROLE_NORMAL, Status: richterv1.UserStatus_USER_STATUS_ACTIVE,
	})
	if err != nil {
		t.Fatalf("create owner: %v", err)
	}
	orgRes, err := c.orgs.CreateOrganization(ctx, &richterv1.CreateOrganizationRequest{
		CreatedBy: ownerRes.User.Id, Name: gofakeit.Company(), Slug: testSlug(),
	})
	if err != nil {
		t.Fatalf("create org: %v", err)
	}
	orgID := orgRes.Organization.Id
	studentEmail, studentPassword, studentID := createActiveUser(t, c.users)
	_, err = c.members.AddOrganizationMember(ctx, &richterv1.AddOrganizationMemberRequest{
		OrganizationId: orgID, UserId: studentID,
		Role:   richterv1.OrganizationRole_ORGANIZATION_ROLE_STUDENT,
		Status: richterv1.MemberStatus_MEMBER_STATUS_ACTIVE,
	})
	if err != nil {
		t.Fatalf("add student: %v", err)
	}
	courseRes, _ := c.courses.CreateCourse(ctx, &richterv1.CreateCourseRequest{OrganizationId: orgID, OwnerId: ownerRes.User.Id, Title: gofakeit.JobTitle()})
	moduleRes, _ := c.modules.CreateCourseModule(ctx, &richterv1.CreateCourseModuleRequest{CourseId: courseRes.Course.Id, Title: gofakeit.JobTitle(), OrderIndex: 0})
	lessonRes, _ := c.lessons.CreateLesson(ctx, &richterv1.CreateLessonRequest{ModuleId: moduleRes.Module.Id, Title: gofakeit.JobTitle(), OrderIndex: 0})
	lessonID := lessonRes.Lesson.Id

	// Create READING (pronunciation mode) — new schema: passage_markdown, no nested MCQs
	createRes, err := c.interactions.CreateManualInteraction(ctx, &richterv1.CreateManualInteractionRequest{
		LessonId:     lessonID,
		Prompt:       "Đọc đoạn văn sau to và rõ ràng",
		StartSeconds: 0,
		Config: &richterv1.CreateManualInteractionRequest_Reading{
			Reading: &richterv1.ReadingConfig{
				Mode:            richterv1.ReadingMode_READING_MODE_PRONUNCIATION,
				PassageMarkdown: "**Newton** phát biểu ba định luật chuyển động cơ học.",
			},
		},
	})
	if err != nil {
		t.Fatalf("create reading interaction: %v", err)
	}
	interactionID := createRes.Interaction.Id
	if createRes.Interaction.Kind != richterv1.InteractionKind_INTERACTION_KIND_READING {
		t.Errorf("kind: want READING, got %v", createRes.Interaction.Kind)
	}
	rc := createRes.Interaction.GetReading()
	if rc == nil {
		t.Fatal("expected ReadingConfig on created interaction")
	}
	if rc.Mode != richterv1.ReadingMode_READING_MODE_PRONUNCIATION {
		t.Errorf("mode: want PRONUNCIATION, got %v", rc.Mode)
	}

	// Student submits with no audio recorded (empty audio_object_key).
	// GradeWithContext short-circuits with score 0/1 when audio_object_key is empty,
	// so no S3 download is attempted — safe for tests without real audio objects.
	studentToken := getUserToken(t, url, studentEmail, studentPassword)
	studentIA := richterv1connect.NewInteractionServiceClient(httpClientWithToken(studentToken), url)

	submitRes, err := studentIA.SubmitAttempt(ctx, &richterv1.SubmitAttemptRequest{
		LessonId: lessonID,
		Responses: []*richterv1.AttemptResponseInput{{
			InteractionId: interactionID,
			Response: &richterv1.AttemptResponseInput_Reading{
				Reading: &richterv1.ReadingResponse{AudioObjectKey: ""},
			},
		}},
	})
	if err != nil {
		t.Fatalf("submit attempt: %v", err)
	}
	if submitRes.Attempt.MaxScore != 1.0 {
		t.Errorf("maxScore: want 1, got %v", submitRes.Attempt.MaxScore)
	}

	// Verify round-trip: response type is ReadingResponse
	getRes, err := studentIA.GetMyAttempt(ctx, &richterv1.GetMyAttemptRequest{LessonId: lessonID})
	if err != nil {
		t.Fatalf("GetMyAttempt: %v", err)
	}
	if len(getRes.Attempt.Responses) != 1 {
		t.Fatalf("expected 1 response, got %d", len(getRes.Attempt.Responses))
	}
	_, ok := getRes.Attempt.Responses[0].Response.(*richterv1.LessonAttemptResponse_Reading)
	if !ok {
		t.Fatalf("expected ReadingResponse, got %T", getRes.Attempt.Responses[0].Response)
	}

	// ── OPEN_ANSWER mode: expected_answer round-trips for teacher, hides for student ──
	openCreateRes, err := c.interactions.CreateManualInteraction(ctx, &richterv1.CreateManualInteractionRequest{
		LessonId:     lessonID,
		Prompt:       "Trả lời câu hỏi sau bằng lời nói",
		StartSeconds: 10,
		Config: &richterv1.CreateManualInteractionRequest_Reading{
			Reading: &richterv1.ReadingConfig{
				Mode:            richterv1.ReadingMode_READING_MODE_OPEN_ANSWER,
				PassageMarkdown: "Newton phát biểu ba định luật chuyển động.",
				Question:        "Ai phát biểu ba định luật chuyển động?",
				ExpectedAnswer:  "Newton phát biểu ba định luật chuyển động.",
			},
		},
	})
	if err != nil {
		t.Fatalf("create open_answer reading: %v", err)
	}
	if openCreateRes.Interaction.GetReading().GetExpectedAnswer() != "Newton phát biểu ba định luật chuyển động." {
		t.Errorf("teacher create did not return expected_answer (response is teacher-side, should expose): got %q",
			openCreateRes.Interaction.GetReading().GetExpectedAnswer())
	}

	// Student lists interactions — expected_answer must be stripped.
	studentList, err := studentIA.ListLessonInteractions(ctx, &richterv1.ListLessonInteractionsRequest{
		LessonId: lessonID, Limit: 50, Offset: 0,
	})
	if err != nil {
		t.Fatalf("student ListLessonInteractions: %v", err)
	}
	var openForStudent *richterv1.LessonInteraction
	for _, it := range studentList.Interactions {
		if it.Id == openCreateRes.Interaction.Id {
			openForStudent = it
			break
		}
	}
	if openForStudent == nil {
		t.Fatal("open_answer interaction not visible to student")
	}
	if openForStudent.GetReading().GetExpectedAnswer() != "" {
		t.Errorf("expected_answer leaked to student: %q", openForStudent.GetReading().GetExpectedAnswer())
	}
}

// ── TestCreateManualInteractionChunkAssociation ───────────────────────────────

// TestCreateManualInteractionChunkAssociation verifies that CreateManualInteraction
// correctly associates the new interaction with a chunk when chunk_id is provided,
// and creates an unattached interaction when chunk_id is empty.
func TestCreateManualInteractionChunkAssociation(t *testing.T) {
	c, url := setupInteractionsTestClients(t)
	ctx := context.Background()

	// Setup: org + lesson via admin.
	ownerRes, err := c.users.CreateUserWithRoleAndStatus(ctx, &richterv1.CreateUserWithRoleAndStatusRequest{
		Email: testEmail(), Password: testPassword(),
		FirstName: gofakeit.FirstName(), LastName: gofakeit.LastName(),
		Role: richterv1.UserRole_USER_ROLE_NORMAL, Status: richterv1.UserStatus_USER_STATUS_ACTIVE,
	})
	if err != nil {
		t.Fatalf("create owner: %v", err)
	}
	orgRes, err := c.orgs.CreateOrganization(ctx, &richterv1.CreateOrganizationRequest{
		CreatedBy: ownerRes.User.Id, Name: gofakeit.Company(), Slug: testSlug(),
	})
	if err != nil {
		t.Fatalf("create org: %v", err)
	}
	orgID := orgRes.Organization.Id

	teacherEmail, teacherPass, teacherID := createActiveUser(t, c.users)
	if _, err := c.members.AddOrganizationMember(ctx, &richterv1.AddOrganizationMemberRequest{
		OrganizationId: orgID, UserId: teacherID,
		Role: richterv1.OrganizationRole_ORGANIZATION_ROLE_TEACHER, Status: richterv1.MemberStatus_MEMBER_STATUS_ACTIVE,
	}); err != nil {
		t.Fatalf("add teacher: %v", err)
	}
	teacherToken := getUserToken(t, url, teacherEmail, teacherPass)
	teacherInteractions := richterv1connect.NewInteractionServiceClient(httpClientWithToken(teacherToken), url)

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

	chunk := insertTestChunk(t, lessonID, 0, "")
	chunkID := chunk.ID.String()

	t.Run("WithChunkID/AssociatesInteraction", func(t *testing.T) {
		res, err := teacherInteractions.CreateManualInteraction(ctx, &richterv1.CreateManualInteractionRequest{
			LessonId:     lessonID,
			ChunkId:      chunkID,
			Prompt:       gofakeit.Sentence(5),
			StartSeconds: 10,
			Config: &richterv1.CreateManualInteractionRequest_Mcq{
				Mcq: &richterv1.McqConfig{
					Options:       []*richterv1.McqOption{{Text: "A"}, {Text: "B"}, {Text: "C"}, {Text: "D"}},
					CorrectAnswer: 0,
				},
			},
		})
		if err != nil {
			t.Fatalf("CreateManualInteraction: %v", err)
		}
		if res.Interaction == nil {
			t.Fatal("expected interaction in response")
		}
		if res.Interaction.ChunkId != chunkID {
			t.Errorf("chunk_id: want %q, got %q", chunkID, res.Interaction.ChunkId)
		}
	})

	t.Run("WithoutChunkID/NoAssociation", func(t *testing.T) {
		res, err := teacherInteractions.CreateManualInteraction(ctx, &richterv1.CreateManualInteractionRequest{
			LessonId:     lessonID,
			Prompt:       gofakeit.Sentence(5),
			StartSeconds: 20,
			Config: &richterv1.CreateManualInteractionRequest_Mcq{
				Mcq: &richterv1.McqConfig{
					Options:       []*richterv1.McqOption{{Text: "X"}, {Text: "Y"}, {Text: "Z"}, {Text: "W"}},
					CorrectAnswer: 1,
				},
			},
		})
		if err != nil {
			t.Fatalf("CreateManualInteraction (no chunk_id): %v", err)
		}
		if res.Interaction == nil {
			t.Fatal("expected interaction in response")
		}
		if res.Interaction.ChunkId != "" {
			t.Errorf("chunk_id: want empty, got %q", res.Interaction.ChunkId)
		}
	})
}

// ── TestRegenerateInteraction ─────────────────────────────────────────────────

// TestRegenerateInteraction verifies authz and the unimplemented path (no AI
// configured in the integration-test environment).
func TestRegenerateInteraction(t *testing.T) {
	c, url := setupInteractionsTestClients(t)
	ctx := context.Background()

	// Setup: org + teacher + student + lesson.
	ownerRes, err := c.users.CreateUserWithRoleAndStatus(ctx, &richterv1.CreateUserWithRoleAndStatusRequest{
		Email: testEmail(), Password: testPassword(),
		FirstName: gofakeit.FirstName(), LastName: gofakeit.LastName(),
		Role: richterv1.UserRole_USER_ROLE_NORMAL, Status: richterv1.UserStatus_USER_STATUS_ACTIVE,
	})
	if err != nil {
		t.Fatalf("create owner: %v", err)
	}
	orgRes, err := c.orgs.CreateOrganization(ctx, &richterv1.CreateOrganizationRequest{
		CreatedBy: ownerRes.User.Id, Name: gofakeit.Company(), Slug: testSlug(),
	})
	if err != nil {
		t.Fatalf("create org: %v", err)
	}
	orgID := orgRes.Organization.Id

	teacherEmail, teacherPass, teacherID := createActiveUser(t, c.users)
	studentEmail, studentPass, studentID := createActiveUser(t, c.users)
	for _, m := range []struct {
		id   string
		role richterv1.OrganizationRole
	}{
		{teacherID, richterv1.OrganizationRole_ORGANIZATION_ROLE_TEACHER},
		{studentID, richterv1.OrganizationRole_ORGANIZATION_ROLE_STUDENT},
	} {
		if _, err := c.members.AddOrganizationMember(ctx, &richterv1.AddOrganizationMemberRequest{
			OrganizationId: orgID, UserId: m.id,
			Role: m.role, Status: richterv1.MemberStatus_MEMBER_STATUS_ACTIVE,
		}); err != nil {
			t.Fatalf("add member: %v", err)
		}
	}
	teacherToken := getUserToken(t, url, teacherEmail, teacherPass)
	studentToken := getUserToken(t, url, studentEmail, studentPass)

	teacherIA := richterv1connect.NewInteractionServiceClient(httpClientWithToken(teacherToken), url)
	studentIA := richterv1connect.NewInteractionServiceClient(httpClientWithToken(studentToken), url)

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

	ints := insertTestInteractions(t, lessonID, 1)
	interactionID := ints[0].ID.String()

	t.Run("Student/PermissionDenied", func(t *testing.T) {
		assertCode(t, func() error {
			_, err := studentIA.RegenerateInteraction(ctx, &richterv1.RegenerateInteractionRequest{
				InteractionId: interactionID,
			})
			return err
		}(), connect.CodePermissionDenied)
	})

	t.Run("Teacher/NoChunk/FailedPrecondition", func(t *testing.T) {
		// The interaction was inserted without a chunkID. doRegenerateInteraction
		// checks chunk validity before calling Gemini and returns FailedPrecondition.
		// This confirms auth passes and the call reaches the handler logic.
		assertCode(t, func() error {
			_, err := teacherIA.RegenerateInteraction(ctx, &richterv1.RegenerateInteractionRequest{
				InteractionId: interactionID,
			})
			return err
		}(), connect.CodeFailedPrecondition)
	})

	t.Run("InvalidInteractionID", func(t *testing.T) {
		assertCode(t, func() error {
			_, err := teacherIA.RegenerateInteraction(ctx, &richterv1.RegenerateInteractionRequest{
				InteractionId: "not-a-uuid",
			})
			return err
		}(), connect.CodeInvalidArgument)
	})
}
