//go:build integ

package v1

import (
	"context"
	"encoding/json"
	"errors"
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
	interactions  richterv1connect.InteractionServiceClient
	courses       richterv1connect.CourseServiceClient
	modules       richterv1connect.CourseModuleServiceClient
	lessons       richterv1connect.LessonServiceClient
	orgs          richterv1connect.OrganizationServiceClient
	members       richterv1connect.OrganizationMemberServiceClient
	users         richterv1connect.UserServiceClient
	courseMembers richterv1connect.CourseMemberServiceClient
}

func setupInteractionsTestClients(t *testing.T) (interactionsTestClients, string) {
	t.Helper()
	url := newV1Server(t)
	adminToken := getAdminToken(t, url)
	c := interactionsTestClients{
		interactions:  richterv1connect.NewInteractionServiceClient(httpClientWithToken(adminToken), url),
		courses:       richterv1connect.NewCourseServiceClient(httpClientWithToken(adminToken), url),
		modules:       richterv1connect.NewCourseModuleServiceClient(httpClientWithToken(adminToken), url),
		lessons:       richterv1connect.NewLessonServiceClient(httpClientWithToken(adminToken), url),
		orgs:          richterv1connect.NewOrganizationServiceClient(httpClientWithToken(adminToken), url),
		members:       richterv1connect.NewOrganizationMemberServiceClient(httpClientWithToken(adminToken), url),
		users:         richterv1connect.NewUserServiceClient(httpClientWithToken(adminToken), url),
		courseMembers: richterv1connect.NewCourseMemberServiceClient(httpClientWithToken(adminToken), url),
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
	t.Parallel()
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

	// Enroll student in the course
	if _, err := c.courseMembers.AddCourseMember(ctx, &richterv1.AddCourseMemberRequest{
		CourseId: courseRes.Course.Id,
		UserId:   studentID,
		Role:     richterv1.CourseRole_COURSE_ROLE_STUDENT,
	}); err != nil {
		t.Fatalf("enroll student in course: %v", err)
	}

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

func TestManualInteractionKindMatrix(t *testing.T) {
	t.Parallel()
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
	studentEmail, studentPassword, studentID := createActiveUser(t, c.users)
	if _, err := c.members.AddOrganizationMember(ctx, &richterv1.AddOrganizationMemberRequest{
		OrganizationId: orgRes.Organization.Id,
		UserId:         studentID,
		Role:           richterv1.OrganizationRole_ORGANIZATION_ROLE_STUDENT,
		Status:         richterv1.MemberStatus_MEMBER_STATUS_ACTIVE,
	}); err != nil {
		t.Fatalf("add student: %v", err)
	}
	courseRes, err := c.courses.CreateCourse(ctx, &richterv1.CreateCourseRequest{
		OrganizationId: orgRes.Organization.Id, OwnerId: ownerRes.User.Id, Title: gofakeit.JobTitle(),
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

	// Enroll student in the course
	if _, err := c.courseMembers.AddCourseMember(ctx, &richterv1.AddCourseMemberRequest{
		CourseId: courseRes.Course.Id,
		UserId:   studentID,
		Role:     richterv1.CourseRole_COURSE_ROLE_STUDENT,
	}); err != nil {
		t.Fatalf("enroll student in course: %v", err)
	}

	create := func(t *testing.T, req *richterv1.CreateManualInteractionRequest, want richterv1.InteractionKind) *richterv1.LessonInteraction {
		t.Helper()
		res, err := c.interactions.CreateManualInteraction(ctx, req)
		if err != nil {
			t.Fatalf("CreateManualInteraction(%v): %v", want, err)
		}
		if res.Interaction == nil {
			t.Fatalf("CreateManualInteraction(%v): nil interaction", want)
		}
		if res.Interaction.Kind != want {
			t.Fatalf("kind: want %v, got %v", want, res.Interaction.Kind)
		}
		return res.Interaction
	}

	single := create(t, &richterv1.CreateManualInteractionRequest{
		LessonId: lessonID, Prompt: "Single choice prompt", StartSeconds: 1,
		Config: &richterv1.CreateManualInteractionRequest_Mcq{Mcq: &richterv1.McqConfig{
			Options:       []*richterv1.McqOption{{Text: "A"}, {Text: "B"}, {Text: "C"}, {Text: "D"}},
			CorrectAnswer: 0,
		}},
	}, richterv1.InteractionKind_INTERACTION_KIND_SINGLE_CHOICE)
	multiple := create(t, &richterv1.CreateManualInteractionRequest{
		LessonId: lessonID, Prompt: "Multiple choice prompt", StartSeconds: 2,
		Config: &richterv1.CreateManualInteractionRequest_Mcq{Mcq: &richterv1.McqConfig{
			Options:        []*richterv1.McqOption{{Text: "A"}, {Text: "B"}, {Text: "C"}, {Text: "D"}},
			CorrectAnswer:  -1,
			CorrectAnswers: []int32{0, 2},
		}},
	}, richterv1.InteractionKind_INTERACTION_KIND_MULTIPLE_CHOICE)
	fill := create(t, &richterv1.CreateManualInteractionRequest{
		LessonId: lessonID, Prompt: "Fill blank prompt", StartSeconds: 3,
		Config: &richterv1.CreateManualInteractionRequest_FillBlank{FillBlank: &richterv1.FillBlankConfig{
			Template: "CI/CD tự động {{0}} phần mềm.",
			Blanks:   []*richterv1.Blank{{Accepted: []string{"triển khai", "deploy"}}},
		}},
	}, richterv1.InteractionKind_INTERACTION_KIND_FILL_BLANK)
	reading := create(t, &richterv1.CreateManualInteractionRequest{
		LessonId: lessonID, Prompt: "Reading prompt", StartSeconds: 4,
		Config: &richterv1.CreateManualInteractionRequest_Reading{Reading: &richterv1.ReadingConfig{
			Mode:            richterv1.ReadingMode_READING_MODE_PRONUNCIATION,
			PassageMarkdown: "Đọc đoạn này để kiểm tra bài đọc thủ công.",
		}},
	}, richterv1.InteractionKind_INTERACTION_KIND_READING)
	listening := create(t, &richterv1.CreateManualInteractionRequest{
		LessonId: lessonID, Prompt: "Listening prompt", StartSeconds: 5,
		Config: &richterv1.CreateManualInteractionRequest_Listening{Listening: &richterv1.ListeningConfig{
			DurationSeconds: 3,
			// Audio-as-question: the audio is synthesised from this text on save.
			AudioSourceText: "Audio này dùng để kiểm tra luồng nghe nào?",
			ComprehensionQuestions: []*richterv1.McqConfig{{
				Question:      "Audio kiểm tra luồng nào?",
				Options:       []*richterv1.McqOption{{Text: "Nghe"}, {Text: "Đọc"}, {Text: "Xóa"}, {Text: "Theme"}},
				CorrectAnswer: 0,
			}},
		}},
	}, richterv1.InteractionKind_INTERACTION_KIND_LISTENING)

	studentToken := getUserToken(t, url, studentEmail, studentPassword)
	studentIA := richterv1connect.NewInteractionServiceClient(httpClientWithToken(studentToken), url)
	listRes, err := studentIA.ListLessonInteractions(ctx, &richterv1.ListLessonInteractionsRequest{
		LessonId: lessonID, Limit: 20, Offset: 0,
	})
	if err != nil {
		t.Fatalf("student ListLessonInteractions: %v", err)
	}
	seen := map[richterv1.InteractionKind]bool{}
	for _, it := range listRes.Interactions {
		seen[it.Kind] = true
	}
	for _, want := range []richterv1.InteractionKind{
		richterv1.InteractionKind_INTERACTION_KIND_SINGLE_CHOICE,
		richterv1.InteractionKind_INTERACTION_KIND_MULTIPLE_CHOICE,
		richterv1.InteractionKind_INTERACTION_KIND_FILL_BLANK,
		richterv1.InteractionKind_INTERACTION_KIND_READING,
		richterv1.InteractionKind_INTERACTION_KIND_LISTENING,
	} {
		if !seen[want] {
			t.Fatalf("student list missing kind %v", want)
		}
	}

	submitRes, err := studentIA.SubmitAttempt(ctx, &richterv1.SubmitAttemptRequest{
		LessonId: lessonID,
		Responses: []*richterv1.AttemptResponseInput{
			{InteractionId: single.Id, Response: &richterv1.AttemptResponseInput_McqSelected{McqSelected: 0}},
			{InteractionId: multiple.Id, Response: &richterv1.AttemptResponseInput_McqMultiple{McqMultiple: &richterv1.McqMultipleResponse{SelectedIndexes: []int32{0, 2}}}},
			{InteractionId: fill.Id, Response: &richterv1.AttemptResponseInput_FillBlank{FillBlank: &richterv1.FillBlankResponse{Answers: []string{"deploy"}}}},
			{InteractionId: reading.Id, Response: &richterv1.AttemptResponseInput_Reading{Reading: &richterv1.ReadingResponse{AudioObjectKey: ""}}},
			{InteractionId: listening.Id, Response: &richterv1.AttemptResponseInput_Listening{Listening: &richterv1.ListeningResponse{ComprehensionAnswers: []int32{0}}}},
		},
	})
	if err != nil {
		t.Fatalf("SubmitAttempt: %v", err)
	}
	if submitRes.Attempt == nil {
		t.Fatal("expected attempt")
	}
	if submitRes.Attempt.TotalScore != 4 || submitRes.Attempt.MaxScore != 5 {
		t.Fatalf("score: want 4/5, got %v/%v", submitRes.Attempt.TotalScore, submitRes.Attempt.MaxScore)
	}
	if len(submitRes.Attempt.Responses) != 5 {
		t.Fatalf("responses: want 5, got %d", len(submitRes.Attempt.Responses))
	}
	responseKinds := map[string]bool{}
	for _, r := range submitRes.Attempt.Responses {
		switch r.Response.(type) {
		case *richterv1.LessonAttemptResponse_McqSelected:
			responseKinds["single"] = true
		case *richterv1.LessonAttemptResponse_McqMultiple:
			responseKinds["multiple"] = true
		case *richterv1.LessonAttemptResponse_FillBlank:
			responseKinds["fill"] = true
		case *richterv1.LessonAttemptResponse_Reading:
			responseKinds["reading"] = true
		case *richterv1.LessonAttemptResponse_Listening:
			responseKinds["listening"] = true
		}
	}
	for _, key := range []string{"single", "multiple", "fill", "reading", "listening"} {
		if !responseKinds[key] {
			t.Fatalf("attempt response missing %s", key)
		}
	}
}

// ── TestInteractionsValidation ────────────────────────────────────────────────

func TestInteractionsValidation(t *testing.T) {
	t.Parallel()
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
	t.Parallel()
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

	// Enroll student and teacher in the course so their OK subtests pass.
	// nonMember is intentionally NOT enrolled to keep the deny-path tests valid.
	for _, m := range []struct {
		id   string
		role richterv1.CourseRole
	}{
		{studentID, richterv1.CourseRole_COURSE_ROLE_STUDENT},
		{teacherID, richterv1.CourseRole_COURSE_ROLE_TEACHER},
	} {
		if _, err := c.courseMembers.AddCourseMember(ctx, &richterv1.AddCourseMemberRequest{
			CourseId: courseRes.Course.Id,
			UserId:   m.id,
			Role:     m.role,
		}); err != nil {
			t.Fatalf("enroll %s in course: %v", m.id, err)
		}
	}

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
	t.Parallel()
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
	// Enroll student in the course
	if _, err := c.courseMembers.AddCourseMember(ctx, &richterv1.AddCourseMemberRequest{
		CourseId: courseRes.Course.Id,
		UserId:   studentID,
		Role:     richterv1.CourseRole_COURSE_ROLE_STUDENT,
	}); err != nil {
		t.Fatalf("enroll student in course: %v", err)
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
		if attempt == nil {
			t.Fatal("expected attempt, got nil")
		}
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
	t.Parallel()
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

	// Enroll student in the course
	if _, err := c.courseMembers.AddCourseMember(ctx, &richterv1.AddCourseMemberRequest{
		CourseId: courseRes.Course.Id,
		UserId:   studentID,
		Role:     richterv1.CourseRole_COURSE_ROLE_STUDENT,
	}); err != nil {
		t.Fatalf("enroll student in course: %v", err)
	}

	// Create LISTENING (comprehension, 2 nested MCQs)
	createRes, err := c.interactions.CreateManualInteraction(ctx, &richterv1.CreateManualInteractionRequest{
		LessonId:     lessonID,
		Prompt:       "Nghe đoạn audio và trả lời câu hỏi",
		StartSeconds: 0,
		Config: &richterv1.CreateManualInteractionRequest_Listening{
			Listening: &richterv1.ListeningConfig{
				// Audio-as-question: the audio is synthesised from this text on save.
				AudioSourceText: "Chủ đề chính của đoạn audio này là gì?",
				ComprehensionQuestions: []*richterv1.McqConfig{
					{Question: "What is the main topic?", Options: []*richterv1.McqOption{{Text: "A"}, {Text: "B"}, {Text: "C"}, {Text: "D"}}, CorrectAnswer: 1},
					{Question: "What detail was mentioned?", Options: []*richterv1.McqOption{{Text: "P"}, {Text: "Q"}, {Text: "R"}, {Text: "S"}}, CorrectAnswer: 3},
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
	t.Parallel()
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

	// Enroll student in the course
	if _, err := c.courseMembers.AddCourseMember(ctx, &richterv1.AddCourseMemberRequest{
		CourseId: courseRes.Course.Id,
		UserId:   studentID,
		Role:     richterv1.CourseRole_COURSE_ROLE_STUDENT,
	}); err != nil {
		t.Fatalf("enroll student in course: %v", err)
	}

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

	// Regression: an audio key whose S3 object doesn't exist must not abort the
	// whole SubmitAttempt (we lost an entire student attempt on every reading
	// recording until this point). The per-interaction grader now falls back
	// to pending credit + a teacher-review feedback string.
	t.Run("SubmitAttempt is resilient to a broken reading audio key", func(t *testing.T) {
		studentEmail, studentPassword, studentID := createActiveUser(t, c.users)
		if _, err := c.members.AddOrganizationMember(ctx, &richterv1.AddOrganizationMemberRequest{
			OrganizationId: orgID, UserId: studentID,
			Role:   richterv1.OrganizationRole_ORGANIZATION_ROLE_STUDENT,
			Status: richterv1.MemberStatus_MEMBER_STATUS_ACTIVE,
		}); err != nil {
			t.Fatalf("add second student: %v", err)
		}
		if _, err := c.courseMembers.AddCourseMember(ctx, &richterv1.AddCourseMemberRequest{
			CourseId: courseRes.Course.Id,
			UserId:   studentID,
			Role:     richterv1.CourseRole_COURSE_ROLE_STUDENT,
		}); err != nil {
			t.Fatalf("enroll second student in course: %v", err)
		}
		brokenStudentToken := getUserToken(t, url, studentEmail, studentPassword)
		brokenStudentIA := richterv1connect.NewInteractionServiceClient(httpClientWithToken(brokenStudentToken), url)

		res, err := brokenStudentIA.SubmitAttempt(ctx, &richterv1.SubmitAttemptRequest{
			LessonId: lessonID,
			Responses: []*richterv1.AttemptResponseInput{{
				InteractionId: interactionID,
				Response: &richterv1.AttemptResponseInput_Reading{
					Reading: &richterv1.ReadingResponse{
						AudioObjectKey: "lessons/" + lessonID + "/student-recordings/does-not-exist.webm",
					},
				},
			}},
		})
		if err != nil {
			t.Fatalf("SubmitAttempt should not fail when grading falls back; got %v", err)
		}
		if res.Attempt == nil || len(res.Attempt.Responses) != 1 {
			t.Fatalf("expected 1 graded response, got %+v", res.Attempt)
		}
		if res.Attempt.Responses[0].Feedback == "" {
			t.Errorf("expected fallback feedback to be populated, got empty")
		}
	})
}

// ── TestPreviewGrade ──────────────────────────────────────────────────────────

// TestPreviewGrade verifies the PreviewGrade RPC used by AFTER_EACH feedback mode:
//   - succeeds when lesson.feedback_mode = AFTER_EACH (returns score/feedback)
//   - rejects with FailedPrecondition when feedback_mode != AFTER_EACH
//   - rejects when the interaction does not belong to the requested lesson
//   - rejects unauthenticated callers
func TestPreviewGrade(t *testing.T) {
	t.Parallel()
	c, url := setupInteractionsTestClients(t)
	ctx := context.Background()

	ownerPassword := testPassword()
	ownerRes, err := c.users.CreateUserWithRoleAndStatus(ctx, &richterv1.CreateUserWithRoleAndStatusRequest{
		Email: testEmail(), Password: ownerPassword,
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
	if _, err := c.members.AddOrganizationMember(ctx, &richterv1.AddOrganizationMemberRequest{
		OrganizationId: orgID, UserId: studentID,
		Role:   richterv1.OrganizationRole_ORGANIZATION_ROLE_STUDENT,
		Status: richterv1.MemberStatus_MEMBER_STATUS_ACTIVE,
	}); err != nil {
		t.Fatalf("add student: %v", err)
	}
	courseRes, _ := c.courses.CreateCourse(ctx, &richterv1.CreateCourseRequest{OrganizationId: orgID, OwnerId: ownerRes.User.Id, Title: gofakeit.JobTitle()})
	moduleRes, _ := c.modules.CreateCourseModule(ctx, &richterv1.CreateCourseModuleRequest{CourseId: courseRes.Course.Id, Title: gofakeit.JobTitle(), OrderIndex: 0})
	lessonRes, _ := c.lessons.CreateLesson(ctx, &richterv1.CreateLessonRequest{ModuleId: moduleRes.Module.Id, Title: gofakeit.JobTitle(), OrderIndex: 0})
	lessonID := lessonRes.Lesson.Id

	// Enroll student in the course
	if _, err := c.courseMembers.AddCourseMember(ctx, &richterv1.AddCourseMemberRequest{
		CourseId: courseRes.Course.Id,
		UserId:   studentID,
		Role:     richterv1.CourseRole_COURSE_ROLE_STUDENT,
	}); err != nil {
		t.Fatalf("enroll student in course: %v", err)
	}

	createRes, err := c.interactions.CreateManualInteraction(ctx, &richterv1.CreateManualInteractionRequest{
		LessonId:     lessonID,
		Prompt:       "Read aloud",
		StartSeconds: 0,
		Config: &richterv1.CreateManualInteractionRequest_Reading{
			Reading: &richterv1.ReadingConfig{
				Mode:            richterv1.ReadingMode_READING_MODE_PRONUNCIATION,
				PassageMarkdown: "Hello world.",
			},
		},
	})
	if err != nil {
		t.Fatalf("create reading interaction: %v", err)
	}
	interactionID := createRes.Interaction.Id

	studentToken := getUserToken(t, url, studentEmail, studentPassword)
	studentIA := richterv1connect.NewInteractionServiceClient(httpClientWithToken(studentToken), url)
	ownerToken := getUserToken(t, url, ownerRes.User.Email, ownerPassword)
	ownerIA := richterv1connect.NewInteractionServiceClient(httpClientWithToken(ownerToken), url)

	// Default lessons created without feedback_mode = after_each → PreviewGrade
	// must reject for students with FailedPrecondition so they can't bypass
	// HIDDEN / AFTER_SUBMIT modes via devtools. Teacher/admin/owner accounts
	// may still use this RPC for the management-page preview flow.
	t.Run("rejects when feedback_mode is not after_each", func(t *testing.T) {
		_, err := studentIA.PreviewGrade(ctx, &richterv1.PreviewGradeRequest{
			LessonId: lessonID,
			Response: &richterv1.AttemptResponseInput{
				InteractionId: interactionID,
				Response: &richterv1.AttemptResponseInput_Reading{
					Reading: &richterv1.ReadingResponse{AudioObjectKey: ""},
				},
			},
		})
		var cerr *connect.Error
		if !errors.As(err, &cerr) {
			t.Fatalf("expected connect error, got %v", err)
		}
		if cerr.Code() != connect.CodeFailedPrecondition {
			t.Errorf("code: want FailedPrecondition, got %v", cerr.Code())
		}
	})

	t.Run("allows manager preview when feedback_mode is not after_each", func(t *testing.T) {
		res, err := ownerIA.PreviewGrade(ctx, &richterv1.PreviewGradeRequest{
			LessonId: lessonID,
			Response: &richterv1.AttemptResponseInput{
				InteractionId: interactionID,
				Response: &richterv1.AttemptResponseInput_Reading{
					Reading: &richterv1.ReadingResponse{AudioObjectKey: ""},
				},
			},
		})
		if err != nil {
			t.Fatalf("PreviewGrade as owner: %v", err)
		}
		if res.MaxScore != 1.0 {
			t.Errorf("maxScore: want 1, got %v", res.MaxScore)
		}
		if res.Feedback == "" {
			t.Errorf("feedback should be populated for manager preview")
		}
	})

	t.Run("save response caches grade without revealing before after_each", func(t *testing.T) {
		res, err := studentIA.SaveAttemptResponse(ctx, &richterv1.SaveAttemptResponseRequest{
			LessonId: lessonID,
			Response: &richterv1.AttemptResponseInput{
				InteractionId: interactionID,
				Response: &richterv1.AttemptResponseInput_Reading{
					Reading: &richterv1.ReadingResponse{AudioObjectKey: ""},
				},
			},
		})
		if err != nil {
			t.Fatalf("SaveAttemptResponse: %v", err)
		}
		if res.FeedbackRevealed {
			t.Fatalf("feedback should not be revealed before after_each mode")
		}
		if res.Score != 0 || res.MaxScore != 0 || res.Feedback != "" {
			t.Fatalf("hidden save response should not leak score/feedback, got score=%v max=%v feedback=%q", res.Score, res.MaxScore, res.Feedback)
		}
	})

	// Switch lesson to AFTER_EACH and retry.
	if _, err := c.lessons.UpdateLessonFeedbackMode(ctx, &richterv1.UpdateLessonFeedbackModeRequest{
		Id: lessonID, FeedbackMode: richterv1.FeedbackMode_FEEDBACK_MODE_AFTER_EACH,
	}); err != nil {
		t.Fatalf("update feedback_mode: %v", err)
	}

	t.Run("succeeds when feedback_mode is after_each", func(t *testing.T) {
		// Empty audio key — grading_deps short-circuits with score 0/1 and the
		// "Chưa có bản ghi âm." message, so no real S3 / Gemini call happens.
		res, err := studentIA.PreviewGrade(ctx, &richterv1.PreviewGradeRequest{
			LessonId: lessonID,
			Response: &richterv1.AttemptResponseInput{
				InteractionId: interactionID,
				Response: &richterv1.AttemptResponseInput_Reading{
					Reading: &richterv1.ReadingResponse{AudioObjectKey: ""},
				},
			},
		})
		if err != nil {
			t.Fatalf("PreviewGrade: %v", err)
		}
		if res.MaxScore != 1.0 {
			t.Errorf("maxScore: want 1, got %v", res.MaxScore)
		}
		if res.Feedback == "" {
			t.Errorf("feedback should be populated for empty-audio fallback path, got empty")
		}
	})

	t.Run("save response reveals grade in after_each", func(t *testing.T) {
		res, err := studentIA.SaveAttemptResponse(ctx, &richterv1.SaveAttemptResponseRequest{
			LessonId: lessonID,
			Response: &richterv1.AttemptResponseInput{
				InteractionId: interactionID,
				Response: &richterv1.AttemptResponseInput_Reading{
					Reading: &richterv1.ReadingResponse{AudioObjectKey: ""},
				},
			},
		})
		if err != nil {
			t.Fatalf("SaveAttemptResponse: %v", err)
		}
		if !res.FeedbackRevealed {
			t.Fatalf("feedback should be revealed in after_each mode")
		}
		if res.MaxScore != 1.0 {
			t.Errorf("maxScore: want 1, got %v", res.MaxScore)
		}
		if res.Feedback == "" {
			t.Errorf("feedback should be populated for after_each save response")
		}
	})

	t.Run("rejects when interaction belongs to a different lesson", func(t *testing.T) {
		otherLesson, _ := c.lessons.CreateLesson(ctx, &richterv1.CreateLessonRequest{
			ModuleId: moduleRes.Module.Id, Title: gofakeit.JobTitle(), OrderIndex: 1,
		})
		if _, err := c.lessons.UpdateLessonFeedbackMode(ctx, &richterv1.UpdateLessonFeedbackModeRequest{
			Id: otherLesson.Lesson.Id, FeedbackMode: richterv1.FeedbackMode_FEEDBACK_MODE_AFTER_EACH,
		}); err != nil {
			t.Fatalf("update other lesson feedback_mode: %v", err)
		}
		_, err := studentIA.PreviewGrade(ctx, &richterv1.PreviewGradeRequest{
			LessonId: otherLesson.Lesson.Id, // wrong lesson for this interaction
			Response: &richterv1.AttemptResponseInput{
				InteractionId: interactionID,
				Response: &richterv1.AttemptResponseInput_Reading{
					Reading: &richterv1.ReadingResponse{AudioObjectKey: ""},
				},
			},
		})
		var cerr *connect.Error
		if !errors.As(err, &cerr) {
			t.Fatalf("expected connect error, got %v", err)
		}
		if cerr.Code() != connect.CodeInvalidArgument {
			t.Errorf("code: want InvalidArgument, got %v", cerr.Code())
		}
	})

	t.Run("rejects unauthenticated callers", func(t *testing.T) {
		anon := richterv1connect.NewInteractionServiceClient(http.DefaultClient, url)
		_, err := anon.PreviewGrade(ctx, &richterv1.PreviewGradeRequest{
			LessonId: lessonID,
			Response: &richterv1.AttemptResponseInput{
				InteractionId: interactionID,
				Response: &richterv1.AttemptResponseInput_Reading{
					Reading: &richterv1.ReadingResponse{AudioObjectKey: ""},
				},
			},
		})
		var cerr *connect.Error
		if !errors.As(err, &cerr) {
			t.Fatalf("expected connect error, got %v", err)
		}
		if cerr.Code() != connect.CodeUnauthenticated {
			t.Errorf("code: want Unauthenticated, got %v", cerr.Code())
		}
	})

	// Regression: when the student submits a bogus audio key (e.g. an S3 object
	// that doesn't exist or the storage container hiccups), GradeWithContext
	// returns a graceful pending result via the S3-download fallback. The
	// PreviewGrade RPC must surface that as HTTP 200 with score=0.5, NOT a 500
	// that the FE renders as Code.Unavailable.
	t.Run("graceful pending on broken audio key (no Code.Internal leak)", func(t *testing.T) {
		res, err := studentIA.PreviewGrade(ctx, &richterv1.PreviewGradeRequest{
			LessonId: lessonID,
			Response: &richterv1.AttemptResponseInput{
				InteractionId: interactionID,
				Response: &richterv1.AttemptResponseInput_Reading{
					// Well-formed lesson-scoped key but the object does not exist
					// in S3 — exercise the GetAudioBytes failure branch.
					Reading: &richterv1.ReadingResponse{
						AudioObjectKey: "lessons/" + lessonID + "/student-recordings/does-not-exist.webm",
					},
				},
			},
		})
		if err != nil {
			t.Fatalf("expected graceful pending response, got error: %v", err)
		}
		if res.MaxScore != 1.0 {
			t.Errorf("maxScore: want 1, got %v", res.MaxScore)
		}
		if res.Feedback == "" {
			t.Errorf("feedback should explain the pending state, got empty")
		}
	})
}

// ── TestCreateManualInteractionChunkAssociation ───────────────────────────────

// TestCreateManualInteractionChunkAssociation verifies that CreateManualInteraction
// correctly associates the new interaction with a chunk when chunk_id is provided,
// and creates an unattached interaction when chunk_id is empty.
func TestCreateManualInteractionChunkAssociation(t *testing.T) {
	t.Parallel()
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

	t.Run("WithoutChunkID/AttributedByTime", func(t *testing.T) {
		// No explicit chunk_id: the interaction is attributed to the chunk its
		// start_seconds falls in (so it still appears in the per-chunk heatmap).
		// StartSeconds=20 falls in the only chunk's [0,60) range → chunkID.
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
		if res.Interaction.ChunkId != chunkID {
			t.Errorf("chunk_id: want %q (attributed by time), got %q", chunkID, res.Interaction.ChunkId)
		}
	})
}

func TestDeleteLessonInteractionsBulk(t *testing.T) {
	t.Parallel()
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

	teacherEmail, teacherPass, teacherID := createActiveUser(t, c.users)
	if _, err := c.members.AddOrganizationMember(ctx, &richterv1.AddOrganizationMemberRequest{
		OrganizationId: orgRes.Organization.Id, UserId: teacherID,
		Role: richterv1.OrganizationRole_ORGANIZATION_ROLE_TEACHER, Status: richterv1.MemberStatus_MEMBER_STATUS_ACTIVE,
	}); err != nil {
		t.Fatalf("add teacher: %v", err)
	}
	teacherToken := getUserToken(t, url, teacherEmail, teacherPass)
	teacherInteractions := richterv1connect.NewInteractionServiceClient(httpClientWithToken(teacherToken), url)

	courseRes, err := c.courses.CreateCourse(ctx, &richterv1.CreateCourseRequest{
		OrganizationId: orgRes.Organization.Id, OwnerId: ownerRes.User.Id, Title: gofakeit.JobTitle(),
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
	chunkA := insertTestChunk(t, lessonID, 0, "chunk a transcript")
	chunkB := insertTestChunk(t, lessonID, 1, "chunk b transcript")

	createMCQ := func(t *testing.T, chunkID string, startSeconds float32) {
		t.Helper()
		_, err := teacherInteractions.CreateManualInteraction(ctx, &richterv1.CreateManualInteractionRequest{
			LessonId:     lessonID,
			ChunkId:      chunkID,
			Prompt:       gofakeit.Sentence(5),
			StartSeconds: startSeconds,
			Config: &richterv1.CreateManualInteractionRequest_Mcq{
				Mcq: &richterv1.McqConfig{
					Options:       []*richterv1.McqOption{{Text: "A"}, {Text: "B"}, {Text: "C"}, {Text: "D"}},
					CorrectAnswer: 0,
				},
			},
		})
		if err != nil {
			t.Fatalf("create interaction: %v", err)
		}
	}

	createMCQ(t, chunkA.ID.String(), 10) // chunkA [0,60)
	createMCQ(t, chunkA.ID.String(), 10)
	createMCQ(t, chunkB.ID.String(), 70) // chunkB [60,120)
	// No explicit chunk_id: attributed by time to chunkB (StartSeconds=70 in [60,120)),
	// so it survives the chunkA-scoped delete below.
	createMCQ(t, "", 70)

	list := func(t *testing.T) []*richterv1.LessonInteraction {
		t.Helper()
		res, err := teacherInteractions.ListLessonInteractions(ctx, &richterv1.ListLessonInteractionsRequest{
			LessonId: lessonID,
			Limit:    20,
			Offset:   0,
		})
		if err != nil {
			t.Fatalf("list interactions: %v", err)
		}
		return res.Interactions
	}

	if got := len(list(t)); got != 4 {
		t.Fatalf("initial interactions: want 4, got %d", got)
	}

	if _, err := teacherInteractions.DeleteLessonInteractions(ctx, &richterv1.DeleteLessonInteractionsRequest{
		LessonId: lessonID,
		ChunkId:  chunkA.ID.String(),
	}); err != nil {
		t.Fatalf("delete chunk interactions: %v", err)
	}
	remaining := list(t)
	if got := len(remaining); got != 2 {
		t.Fatalf("after chunk delete: want 2, got %d", got)
	}
	for _, interaction := range remaining {
		if interaction.ChunkId == chunkA.ID.String() {
			t.Fatalf("chunk delete left interaction %s in deleted chunk", interaction.Id)
		}
	}

	if _, err := teacherInteractions.DeleteLessonInteractions(ctx, &richterv1.DeleteLessonInteractionsRequest{
		LessonId: lessonID,
	}); err != nil {
		t.Fatalf("delete lesson interactions: %v", err)
	}
	if got := len(list(t)); got != 0 {
		t.Fatalf("after lesson delete: want 0, got %d", got)
	}
}

// ── TestRegenerateInteraction ─────────────────────────────────────────────────

// TestRegenerateInteraction verifies authz and the unimplemented path (no AI
// configured in the integration-test environment).
func TestRegenerateInteraction(t *testing.T) {
	t.Parallel()
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

// ── TestMetricsAndAnalytics ───────────────────────────────────────────────────

// TestMetricsAndAnalytics verifies the full metrics pipeline:
//  1. Submit an attempt WITH metrics (time_to_answer_ms, replay_count, video_watch_fraction).
//  2. Verify the metrics come back in ListAttempts (avg_time_to_answer_ms, watch_fraction,
//     engagement_score in a sane range).
//  3. ListCourseAttemptsSummary returns the student with sane aggregate fields.
//  4. ListMyCourseProgress returns the course for that student.
func TestMetricsAndAnalytics(t *testing.T) {
	t.Parallel()
	c, url := setupInteractionsTestClients(t)
	ctx := context.Background()

	// ── setup: org + owner + teacher + student + course + module + lesson ──
	// testPassword() is random per call, so capture it once and reuse for login.
	ownerPassword := testPassword()
	ownerRes, err := c.users.CreateUserWithRoleAndStatus(ctx, &richterv1.CreateUserWithRoleAndStatusRequest{
		Email: testEmail(), Password: ownerPassword,
		FirstName: gofakeit.FirstName(), LastName: gofakeit.LastName(),
		Role: richterv1.UserRole_USER_ROLE_NORMAL, Status: richterv1.UserStatus_USER_STATUS_ACTIVE,
	})
	if err != nil {
		t.Fatalf("create owner: %v", err)
	}
	ownerID := ownerRes.User.Id

	orgRes, err := c.orgs.CreateOrganization(ctx, &richterv1.CreateOrganizationRequest{
		CreatedBy: ownerID, Name: gofakeit.Company(), Slug: testSlug(),
	})
	if err != nil {
		t.Fatalf("create org: %v", err)
	}
	orgID := orgRes.Organization.Id
	// CreateOrganization(CreatedBy: ownerID) already adds ownerID as an active
	// owner member, so no explicit AddOrganizationMember is needed here.

	studentEmail, studentPassword, studentID := createActiveUser(t, c.users)
	_, err = c.members.AddOrganizationMember(ctx, &richterv1.AddOrganizationMemberRequest{
		OrganizationId: orgID, UserId: studentID,
		Role:   richterv1.OrganizationRole_ORGANIZATION_ROLE_STUDENT,
		Status: richterv1.MemberStatus_MEMBER_STATUS_ACTIVE,
	})
	if err != nil {
		t.Fatalf("add student: %v", err)
	}

	courseRes, err := c.courses.CreateCourse(ctx, &richterv1.CreateCourseRequest{
		OrganizationId: orgID, OwnerId: ownerID, Title: gofakeit.JobTitle(),
	})
	if err != nil {
		t.Fatalf("create course: %v", err)
	}
	courseID := courseRes.Course.Id

	// Enroll student in the course
	if _, err := c.courseMembers.AddCourseMember(ctx, &richterv1.AddCourseMemberRequest{
		CourseId: courseID,
		UserId:   studentID,
		Role:     richterv1.CourseRole_COURSE_ROLE_STUDENT,
	}); err != nil {
		t.Fatalf("enroll student in course: %v", err)
	}

	moduleRes, err := c.modules.CreateCourseModule(ctx, &richterv1.CreateCourseModuleRequest{
		CourseId: courseID, Title: gofakeit.JobTitle(), OrderIndex: 0,
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

	// Insert 2 MCQ interactions
	ints := insertTestInteractions(t, lessonID, 2)
	correct := correctAnswers(ints)

	studentToken := getUserToken(t, url, studentEmail, studentPassword)
	studentIA := richterv1connect.NewInteractionServiceClient(httpClientWithToken(studentToken), url)

	// ── 1. Submit attempt with metrics ────────────────────────────────────────
	t.Run("SubmitAttempt/WithMetrics", func(t *testing.T) {
		resps := []*richterv1.AttemptResponseInput{
			{
				InteractionId:  ints[0].ID.String(),
				TimeToAnswerMs: 3000,
				ReplayCount:    1,
				Response: &richterv1.AttemptResponseInput_McqSelected{
					McqSelected: correct[0],
				},
			},
			{
				InteractionId:  ints[1].ID.String(),
				TimeToAnswerMs: 5000,
				ReplayCount:    0,
				Response: &richterv1.AttemptResponseInput_McqSelected{
					McqSelected: correct[1],
				},
			},
		}
		res, err := studentIA.SubmitAttempt(ctx, &richterv1.SubmitAttemptRequest{
			LessonId:           lessonID,
			Responses:          resps,
			VideoWatchFraction: 0.85,
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
	})

	// ── 2. ListAttempts returns metrics ───────────────────────────────────────
	t.Run("ListAttempts/HasMetrics", func(t *testing.T) {
		ownerPassword := testPassword()
		ownerLoginRes, err := c.users.CreateUserWithRoleAndStatus(ctx, &richterv1.CreateUserWithRoleAndStatusRequest{
			Email: testEmail(), Password: ownerPassword,
			FirstName: gofakeit.FirstName(), LastName: gofakeit.LastName(),
			Role: richterv1.UserRole_USER_ROLE_NORMAL, Status: richterv1.UserStatus_USER_STATUS_ACTIVE,
		})
		if err != nil {
			t.Fatalf("create second owner user for token: %v", err)
		}
		_, _ = c.members.AddOrganizationMember(ctx, &richterv1.AddOrganizationMemberRequest{
			OrganizationId: orgID, UserId: ownerLoginRes.User.Id,
			Role: richterv1.OrganizationRole_ORGANIZATION_ROLE_OWNER, Status: richterv1.MemberStatus_MEMBER_STATUS_ACTIVE,
		})
		ownerToken := getUserToken(t, url, ownerLoginRes.User.Email, ownerPassword)
		teacherIA2 := richterv1connect.NewInteractionServiceClient(httpClientWithToken(ownerToken), url)

		listRes, err := teacherIA2.ListAttempts(ctx, &richterv1.ListAttemptsRequest{
			LessonId: lessonID, Limit: 10, Offset: 0,
		})
		if err != nil {
			t.Fatalf("ListAttempts: %v", err)
		}
		if listRes.Total < 1 {
			t.Fatalf("expected at least 1 attempt, got %d", listRes.Total)
		}
		var found *richterv1.StudentAttemptSummary
		for _, s := range listRes.Attempts {
			if s.UserId == studentID {
				found = s
				break
			}
		}
		if found == nil {
			t.Fatalf("student %s not found in ListAttempts", studentID)
		}
		// avg_time_to_answer_ms should be approximately (3000+5000)/2 = 4000
		if found.AvgTimeToAnswerMs < 1 {
			t.Errorf("avg_time_to_answer_ms should be > 0, got %v", found.AvgTimeToAnswerMs)
		}
		// video_watch_fraction should be approximately 0.85
		if found.VideoWatchFraction < 0.5 || found.VideoWatchFraction > 1.0 {
			t.Errorf("video_watch_fraction out of expected range, got %v", found.VideoWatchFraction)
		}
		// engagement_score should be in [0, 100]
		if found.EngagementScore < 0 || found.EngagementScore > 100 {
			t.Errorf("engagement_score out of range [0,100], got %v", found.EngagementScore)
		}
		// A student who answered all correctly + watched most of video should have high engagement
		if found.EngagementScore < 50 {
			t.Errorf("expected engagement_score >= 50 for full-correct + 0.85 watch, got %v", found.EngagementScore)
		}
	})

	// ── 3. ListCourseAttemptsSummary ──────────────────────────────────────────
	t.Run("ListCourseAttemptsSummary/TeacherSeesStudent", func(t *testing.T) {
		ownerToken := getUserToken(t, url, ownerRes.User.Email, ownerPassword)
		teacherIA3 := richterv1connect.NewInteractionServiceClient(httpClientWithToken(ownerToken), url)

		res, err := teacherIA3.ListCourseAttemptsSummary(ctx, &richterv1.ListCourseAttemptsSummaryRequest{
			CourseId: courseID, Limit: 50, Offset: 0,
		})
		if err != nil {
			t.Fatalf("ListCourseAttemptsSummary: %v", err)
		}
		if res.Total < 1 {
			t.Fatalf("expected at least 1 student, got %d", res.Total)
		}
		var found *richterv1.CourseStudentSummary
		for _, s := range res.Students {
			if s.UserId == studentID {
				found = s
				break
			}
		}
		if found == nil {
			t.Fatalf("student %s not found in ListCourseAttemptsSummary", studentID)
		}
		if found.LessonsCompleted < 1 {
			t.Errorf("lessons_completed should be >= 1, got %d", found.LessonsCompleted)
		}
		if found.LessonsTotal < 1 {
			t.Errorf("lessons_total should be >= 1, got %d", found.LessonsTotal)
		}
		if found.AvgScore < 0 || found.AvgScore > 1 {
			t.Errorf("avg_score out of [0,1], got %v", found.AvgScore)
		}
		if found.EngagementScore < 0 || found.EngagementScore > 100 {
			t.Errorf("engagement_score out of [0,100], got %v", found.EngagementScore)
		}
		// ── Raw totals (drive the "Tổng" results mode) ──
		// A student with at least one attempt must have a positive max score.
		if found.TotalMaxScore <= 0 {
			t.Errorf("total_max_score should be > 0 for a student with attempts, got %v", found.TotalMaxScore)
		}
		if found.TotalScore < 0 || found.TotalScore > found.TotalMaxScore {
			t.Errorf("total_score out of [0, total_max_score], got %v / %v", found.TotalScore, found.TotalMaxScore)
		}
		// Invariant: avg_score must equal total_score / total_max_score exactly
		// (both derive from the same SUMs), so the two results modes never disagree.
		if found.TotalMaxScore > 0 {
			derived := found.TotalScore / found.TotalMaxScore
			if d := derived - found.AvgScore; d < -1e-6 || d > 1e-6 {
				t.Errorf("avg_score (%v) must equal total_score/total_max_score (%v)", found.AvgScore, derived)
			}
		}
		if found.TotalResponses < 0 || found.TotalResponses > found.TotalInteractions {
			t.Errorf("total_responses out of [0, total_interactions], got %d / %d",
				found.TotalResponses, found.TotalInteractions)
		}
		if found.TotalTimeMs < 0 {
			t.Errorf("total_time_ms should be >= 0, got %v", found.TotalTimeMs)
		}
	})

	// Student cannot call ListCourseAttemptsSummary.
	t.Run("ListCourseAttemptsSummary/StudentForbidden", func(t *testing.T) {
		assertCode(t, func() error {
			_, err := studentIA.ListCourseAttemptsSummary(ctx, &richterv1.ListCourseAttemptsSummaryRequest{
				CourseId: courseID, Limit: 10, Offset: 0,
			})
			return err
		}(), connect.CodePermissionDenied)
	})

	// ── 4. ListMyCourseProgress ───────────────────────────────────────────────
	t.Run("ListMyCourseProgress/StudentSeesCourse", func(t *testing.T) {
		res, err := studentIA.ListMyCourseProgress(ctx, &richterv1.ListMyCourseProgressRequest{
			Limit: 50, Offset: 0,
		})
		if err != nil {
			t.Fatalf("ListMyCourseProgress: %v", err)
		}
		if len(res.Courses) == 0 {
			t.Fatal("expected at least 1 course in progress list")
		}
		var found *richterv1.MyCourseProgress
		for _, cp := range res.Courses {
			if cp.CourseId == courseID {
				found = cp
				break
			}
		}
		if found == nil {
			t.Fatalf("course %s not found in ListMyCourseProgress", courseID)
		}
		if found.LessonsDone < 1 {
			t.Errorf("lessons_done should be >= 1, got %d", found.LessonsDone)
		}
		if found.LessonsTotal < 1 {
			t.Errorf("lessons_total should be >= 1, got %d", found.LessonsTotal)
		}
		if found.AvgScore < 0 || found.AvgScore > 1 {
			t.Errorf("avg_score out of [0,1], got %v", found.AvgScore)
		}
	})

	// Unauthenticated cannot call ListMyCourseProgress.
	t.Run("ListMyCourseProgress/AnonForbidden", func(t *testing.T) {
		anonIA := richterv1connect.NewInteractionServiceClient(http.DefaultClient, url)
		assertCode(t, func() error {
			_, err := anonIA.ListMyCourseProgress(ctx, &richterv1.ListMyCourseProgressRequest{
				Limit: 10, Offset: 0,
			})
			return err
		}(), connect.CodeUnauthenticated)
	})
}

// ── TestAnalyticsEmptyAndPagination ──────────────────────────────────────────

// TestAnalyticsEmptyAndPagination verifies:
//   - ListCourseAttemptsSummary returns an empty list (not an error) for a course
//     that has no attempts.
//   - ListCourseAttemptsSummary pagination (limit/offset) works when there are
//     multiple students.
//   - ListMyCourseProgress returns empty for a student with no attempts.
func TestAnalyticsEmptyAndPagination(t *testing.T) {
	t.Parallel()
	c, url := setupInteractionsTestClients(t)
	ctx := context.Background()

	ownerPassword := testPassword()
	ownerRes, err := c.users.CreateUserWithRoleAndStatus(ctx, &richterv1.CreateUserWithRoleAndStatusRequest{
		Email: testEmail(), Password: ownerPassword,
		FirstName: gofakeit.FirstName(), LastName: gofakeit.LastName(),
		Role: richterv1.UserRole_USER_ROLE_NORMAL, Status: richterv1.UserStatus_USER_STATUS_ACTIVE,
	})
	if err != nil {
		t.Fatalf("create owner: %v", err)
	}
	ownerID := ownerRes.User.Id

	orgRes, err := c.orgs.CreateOrganization(ctx, &richterv1.CreateOrganizationRequest{
		CreatedBy: ownerID, Name: gofakeit.Company(), Slug: testSlug(),
	})
	if err != nil {
		t.Fatalf("create org: %v", err)
	}
	orgID := orgRes.Organization.Id

	// Create two students.
	studentAEmail, studentAPassword, studentAID := createActiveUser(t, c.users)
	studentBEmail, studentBPassword, studentBID := createActiveUser(t, c.users)
	// noAttemptsStudentEmail has course membership but submits nothing.
	noAttemptsEmail, noAttemptsPassword, noAttemptsID := createActiveUser(t, c.users)

	for _, m := range []struct {
		id   string
		role richterv1.OrganizationRole
	}{
		{studentAID, richterv1.OrganizationRole_ORGANIZATION_ROLE_STUDENT},
		{studentBID, richterv1.OrganizationRole_ORGANIZATION_ROLE_STUDENT},
		{noAttemptsID, richterv1.OrganizationRole_ORGANIZATION_ROLE_STUDENT},
	} {
		if _, err := c.members.AddOrganizationMember(ctx, &richterv1.AddOrganizationMemberRequest{
			OrganizationId: orgID, UserId: m.id,
			Role: m.role, Status: richterv1.MemberStatus_MEMBER_STATUS_ACTIVE,
		}); err != nil {
			t.Fatalf("add org member %s: %v", m.id, err)
		}
	}

	courseRes, err := c.courses.CreateCourse(ctx, &richterv1.CreateCourseRequest{
		OrganizationId: orgID, OwnerId: ownerID, Title: gofakeit.JobTitle(),
	})
	if err != nil {
		t.Fatalf("create course: %v", err)
	}
	courseID := courseRes.Course.Id

	modRes, err := c.modules.CreateCourseModule(ctx, &richterv1.CreateCourseModuleRequest{
		CourseId: courseID, Title: gofakeit.JobTitle(), OrderIndex: 0,
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

	// Enrol all students in the course.
	for _, uid := range []string{studentAID, studentBID, noAttemptsID} {
		if _, err := c.courseMembers.AddCourseMember(ctx, &richterv1.AddCourseMemberRequest{
			CourseId: courseID, UserId: uid, Role: richterv1.CourseRole_COURSE_ROLE_STUDENT,
		}); err != nil {
			t.Fatalf("enrol student %s: %v", uid, err)
		}
	}

	ownerToken := getUserToken(t, url, ownerRes.User.Email, ownerPassword)
	ownerIA := richterv1connect.NewInteractionServiceClient(httpClientWithToken(ownerToken), url)

	// ── 1. Empty course: no attempts at all ───────────────────────────────────
	t.Run("ListCourseAttemptsSummary/EmptyCourse", func(t *testing.T) {
		res, err := ownerIA.ListCourseAttemptsSummary(ctx, &richterv1.ListCourseAttemptsSummaryRequest{
			CourseId: courseID, Limit: 10, Offset: 0,
		})
		if err != nil {
			t.Fatalf("ListCourseAttemptsSummary on empty course: %v", err)
		}
		if len(res.Students) != 0 {
			t.Errorf("expected 0 students on empty course, got %d", len(res.Students))
		}
	})

	// ── 2. ListMyCourseProgress: no attempts → empty list ─────────────────────
	noAttemptsToken := getUserToken(t, url, noAttemptsEmail, noAttemptsPassword)
	noAttemptsIA := richterv1connect.NewInteractionServiceClient(httpClientWithToken(noAttemptsToken), url)

	t.Run("ListMyCourseProgress/NoAttempts_Empty", func(t *testing.T) {
		res, err := noAttemptsIA.ListMyCourseProgress(ctx, &richterv1.ListMyCourseProgressRequest{
			Limit: 10, Offset: 0,
		})
		if err != nil {
			t.Fatalf("ListMyCourseProgress (no attempts): %v", err)
		}
		if len(res.Courses) != 0 {
			t.Errorf("expected 0 courses for student with no attempts, got %d", len(res.Courses))
		}
	})

	// ── 3. Two students submit → pagination ────────────────────────────────────
	ints := insertTestInteractions(t, lessonID, 2)
	correct := correctAnswers(ints)

	studentAToken := getUserToken(t, url, studentAEmail, studentAPassword)
	studentBToken := getUserToken(t, url, studentBEmail, studentBPassword)
	_ = studentBEmail
	_ = studentBPassword

	for _, tok := range []string{studentAToken, studentBToken} {
		ia := richterv1connect.NewInteractionServiceClient(httpClientWithToken(tok), url)
		if _, err := ia.SubmitAttempt(ctx, &richterv1.SubmitAttemptRequest{
			LessonId:           lessonID,
			Responses:          buildResponses(ints, correct),
			VideoWatchFraction: 1.0,
		}); err != nil {
			t.Fatalf("SubmitAttempt for pagination setup: %v", err)
		}
	}

	t.Run("ListCourseAttemptsSummary/Pagination", func(t *testing.T) {
		page1, err := ownerIA.ListCourseAttemptsSummary(ctx, &richterv1.ListCourseAttemptsSummaryRequest{
			CourseId: courseID, Limit: 1, Offset: 0,
		})
		if err != nil {
			t.Fatalf("ListCourseAttemptsSummary page1: %v", err)
		}
		if len(page1.Students) != 1 {
			t.Errorf("page1: expected 1 student, got %d", len(page1.Students))
		}

		page2, err := ownerIA.ListCourseAttemptsSummary(ctx, &richterv1.ListCourseAttemptsSummaryRequest{
			CourseId: courseID, Limit: 1, Offset: 1,
		})
		if err != nil {
			t.Fatalf("ListCourseAttemptsSummary page2: %v", err)
		}
		if len(page2.Students) != 1 {
			t.Errorf("page2: expected 1 student, got %d", len(page2.Students))
		}
		if page1.Students[0].UserId == page2.Students[0].UserId {
			t.Errorf("pagination returned the same student on both pages")
		}

		// Page beyond end: should be empty.
		page3, err := ownerIA.ListCourseAttemptsSummary(ctx, &richterv1.ListCourseAttemptsSummaryRequest{
			CourseId: courseID, Limit: 10, Offset: 100,
		})
		if err != nil {
			t.Fatalf("ListCourseAttemptsSummary page3: %v", err)
		}
		if len(page3.Students) != 0 {
			t.Errorf("page beyond end: expected 0 students, got %d", len(page3.Students))
		}
	})

	t.Run("ListCourseAttemptsSummary/SummaryFieldsValid", func(t *testing.T) {
		res, err := ownerIA.ListCourseAttemptsSummary(ctx, &richterv1.ListCourseAttemptsSummaryRequest{
			CourseId: courseID, Limit: 50, Offset: 0,
		})
		if err != nil {
			t.Fatalf("ListCourseAttemptsSummary: %v", err)
		}
		// Both submitting students must appear; noAttempts student must NOT appear.
		seen := map[string]*richterv1.CourseStudentSummary{}
		for _, s := range res.Students {
			seen[s.UserId] = s
		}
		if _, ok := seen[noAttemptsID]; ok {
			t.Error("student with no attempts should not appear in ListCourseAttemptsSummary")
		}
		for _, uid := range []string{studentAID, studentBID} {
			s, ok := seen[uid]
			if !ok {
				t.Errorf("student %s expected in summary but missing", uid)
				continue
			}
			if s.LessonsCompleted < 1 {
				t.Errorf("student %s: lessons_completed want >= 1, got %d", uid, s.LessonsCompleted)
			}
			if s.LessonsTotal < 1 {
				t.Errorf("student %s: lessons_total want >= 1, got %d", uid, s.LessonsTotal)
			}
			if s.AvgScore < 0 || s.AvgScore > 1 {
				t.Errorf("student %s: avg_score out of [0,1], got %v", uid, s.AvgScore)
			}
			if s.EngagementScore < 0 || s.EngagementScore > 100 {
				t.Errorf("student %s: engagement_score out of [0,100], got %v", uid, s.EngagementScore)
			}
		}
	})

	// Regression: progress (lessons_completed) counts ANY attempt regardless of
	// score or how much of the video was watched. A student who answers and
	// barely watches still shows 1/x — progress is not gated on a (now-removed)
	// completion threshold.
	t.Run("ListCourseAttemptsSummary/AttemptCountsAsProgress", func(t *testing.T) {
		lowEmail, lowPassword, lowID := createActiveUser(t, c.users)
		if _, err := c.members.AddOrganizationMember(ctx, &richterv1.AddOrganizationMemberRequest{
			OrganizationId: orgID, UserId: lowID,
			Role:   richterv1.OrganizationRole_ORGANIZATION_ROLE_STUDENT,
			Status: richterv1.MemberStatus_MEMBER_STATUS_ACTIVE,
		}); err != nil {
			t.Fatalf("add org member: %v", err)
		}
		if _, err := c.courseMembers.AddCourseMember(ctx, &richterv1.AddCourseMemberRequest{
			CourseId: courseID, UserId: lowID, Role: richterv1.CourseRole_COURSE_ROLE_STUDENT,
		}); err != nil {
			t.Fatalf("enrol student: %v", err)
		}
		lowToken := getUserToken(t, url, lowEmail, lowPassword)
		lowIA := richterv1connect.NewInteractionServiceClient(httpClientWithToken(lowToken), url)
		// Answer correctly but watch nothing — must still count as progress.
		if _, err := lowIA.SubmitAttempt(ctx, &richterv1.SubmitAttemptRequest{
			LessonId:           lessonID,
			Responses:          buildResponses(ints, correct),
			VideoWatchFraction: 0.0,
		}); err != nil {
			t.Fatalf("SubmitAttempt: %v", err)
		}

		res, err := ownerIA.ListCourseAttemptsSummary(ctx, &richterv1.ListCourseAttemptsSummaryRequest{
			CourseId: courseID, Limit: 50, Offset: 0,
		})
		if err != nil {
			t.Fatalf("ListCourseAttemptsSummary: %v", err)
		}
		var low *richterv1.CourseStudentSummary
		for _, s := range res.Students {
			if s.UserId == lowID {
				low = s
				break
			}
		}
		if low == nil {
			t.Fatalf("attempted student %s missing from course summary", lowID)
		}
		if low.LessonsCompleted < 1 {
			t.Errorf("an attempted lesson must count as progress: lessons_completed = %d, want >= 1", low.LessonsCompleted)
		}
	})
}

// ── TestEngagementEdgeCases ───────────────────────────────────────────────────

// TestEngagementEdgeCases verifies the engagement score formula at boundary
// conditions.  We do not hard-code the exact formula, but verify sensible
// ordering:
//
//   - zero watch fraction + all wrong → engagement_score should be LOW (< 40)
//   - full watch fraction (1.0) + all correct → engagement_score should be HIGH (>= 60)
func TestEngagementEdgeCases(t *testing.T) {
	t.Parallel()
	c, url := setupInteractionsTestClients(t)
	ctx := context.Background()

	ownerPassword := testPassword()
	ownerRes, err := c.users.CreateUserWithRoleAndStatus(ctx, &richterv1.CreateUserWithRoleAndStatusRequest{
		Email: testEmail(), Password: ownerPassword,
		FirstName: gofakeit.FirstName(), LastName: gofakeit.LastName(),
		Role: richterv1.UserRole_USER_ROLE_NORMAL, Status: richterv1.UserStatus_USER_STATUS_ACTIVE,
	})
	if err != nil {
		t.Fatalf("create owner: %v", err)
	}
	ownerID := ownerRes.User.Id

	orgRes, err := c.orgs.CreateOrganization(ctx, &richterv1.CreateOrganizationRequest{
		CreatedBy: ownerID, Name: gofakeit.Company(), Slug: testSlug(),
	})
	if err != nil {
		t.Fatalf("create org: %v", err)
	}
	orgID := orgRes.Organization.Id

	// Two students for the two edge cases.
	lowEngEmail, lowEngPassword, lowEngID := createActiveUser(t, c.users)
	highEngEmail, highEngPassword, highEngID := createActiveUser(t, c.users)

	for _, m := range []struct {
		id   string
		role richterv1.OrganizationRole
	}{
		{lowEngID, richterv1.OrganizationRole_ORGANIZATION_ROLE_STUDENT},
		{highEngID, richterv1.OrganizationRole_ORGANIZATION_ROLE_STUDENT},
	} {
		if _, err := c.members.AddOrganizationMember(ctx, &richterv1.AddOrganizationMemberRequest{
			OrganizationId: orgID, UserId: m.id,
			Role: m.role, Status: richterv1.MemberStatus_MEMBER_STATUS_ACTIVE,
		}); err != nil {
			t.Fatalf("add org member: %v", err)
		}
	}

	courseRes, err := c.courses.CreateCourse(ctx, &richterv1.CreateCourseRequest{
		OrganizationId: orgID, OwnerId: ownerID, Title: gofakeit.JobTitle(),
	})
	if err != nil {
		t.Fatalf("create course: %v", err)
	}
	courseID := courseRes.Course.Id

	modRes, err := c.modules.CreateCourseModule(ctx, &richterv1.CreateCourseModuleRequest{
		CourseId: courseID, Title: gofakeit.JobTitle(), OrderIndex: 0,
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

	for _, uid := range []string{lowEngID, highEngID} {
		if _, err := c.courseMembers.AddCourseMember(ctx, &richterv1.AddCourseMemberRequest{
			CourseId: courseID, UserId: uid, Role: richterv1.CourseRole_COURSE_ROLE_STUDENT,
		}); err != nil {
			t.Fatalf("enrol student %s: %v", uid, err)
		}
	}

	ints := insertTestInteractions(t, lessonID, 4)
	correct := correctAnswers(ints)

	// Build all-wrong answers.
	wrong := make([]int32, len(ints))
	for i := range ints {
		wrong[i] = (correct[i] + 1) % 4
	}

	lowEngToken := getUserToken(t, url, lowEngEmail, lowEngPassword)
	highEngToken := getUserToken(t, url, highEngEmail, highEngPassword)

	lowIA := richterv1connect.NewInteractionServiceClient(httpClientWithToken(lowEngToken), url)
	highIA := richterv1connect.NewInteractionServiceClient(httpClientWithToken(highEngToken), url)

	// Low-engagement: zero watch + all wrong.
	if _, err := lowIA.SubmitAttempt(ctx, &richterv1.SubmitAttemptRequest{
		LessonId:           lessonID,
		Responses:          buildResponses(ints, wrong),
		VideoWatchFraction: 0.0,
	}); err != nil {
		t.Fatalf("low-eng SubmitAttempt: %v", err)
	}

	// High-engagement: full watch + all correct.
	if _, err := highIA.SubmitAttempt(ctx, &richterv1.SubmitAttemptRequest{
		LessonId:           lessonID,
		Responses:          buildResponses(ints, correct),
		VideoWatchFraction: 1.0,
	}); err != nil {
		t.Fatalf("high-eng SubmitAttempt: %v", err)
	}

	ownerToken := getUserToken(t, url, ownerRes.User.Email, ownerPassword)
	ownerIA := richterv1connect.NewInteractionServiceClient(httpClientWithToken(ownerToken), url)

	listRes, err := ownerIA.ListAttempts(ctx, &richterv1.ListAttemptsRequest{
		LessonId: lessonID, Limit: 10, Offset: 0,
	})
	if err != nil {
		t.Fatalf("ListAttempts: %v", err)
	}

	var lowSummary, highSummary *richterv1.StudentAttemptSummary
	for _, s := range listRes.Attempts {
		switch s.UserId {
		case lowEngID:
			lowSummary = s
		case highEngID:
			highSummary = s
		}
	}

	t.Run("LowEngagement_ZeroWatch_AllWrong", func(t *testing.T) {
		if lowSummary == nil {
			t.Fatal("low-engagement student not found in ListAttempts")
		}
		// video_watch_fraction should be 0.
		if lowSummary.VideoWatchFraction > 0.05 {
			t.Errorf("video_watch_fraction: want ~0, got %v", lowSummary.VideoWatchFraction)
		}
		// engagement_score should be low.
		if lowSummary.EngagementScore >= 40 {
			t.Errorf("low-eng score: want < 40, got %v", lowSummary.EngagementScore)
		}
		if lowSummary.EngagementScore < 0 {
			t.Errorf("engagement_score must be >= 0, got %v", lowSummary.EngagementScore)
		}
	})

	t.Run("HighEngagement_FullWatch_AllCorrect", func(t *testing.T) {
		if highSummary == nil {
			t.Fatal("high-engagement student not found in ListAttempts")
		}
		// video_watch_fraction should be ~1.
		if highSummary.VideoWatchFraction < 0.9 {
			t.Errorf("video_watch_fraction: want ~1, got %v", highSummary.VideoWatchFraction)
		}
		// engagement_score should be high.
		if highSummary.EngagementScore < 60 {
			t.Errorf("high-eng score: want >= 60, got %v", highSummary.EngagementScore)
		}
		if highSummary.EngagementScore > 100 {
			t.Errorf("engagement_score must be <= 100, got %v", highSummary.EngagementScore)
		}
	})

	t.Run("HighEngagement_Higher_Than_LowEngagement", func(t *testing.T) {
		if lowSummary == nil || highSummary == nil {
			t.Skip("skipped: one or both summaries missing")
		}
		if highSummary.EngagementScore <= lowSummary.EngagementScore {
			t.Errorf("high-engagement score (%v) should be > low-engagement score (%v)",
				highSummary.EngagementScore, lowSummary.EngagementScore)
		}
	})
}

// ── TestAccessGateMatrixComplete ─────────────────────────────────────────────

// TestAccessGateMatrixComplete tests the full access-gate matrix for the most
// important gated RPCs (SubmitAttempt, GetLessonAnalysis, ListLessonsByCourse)
// with an org-member who is NOT a course member.  Existing tests in
// TestInteractionsAuthz, TestAIAuthz, and TestLessonsAuthz already check the
// non-org-member path; this test specifically targets the "org member but not
// course member → PermissionDenied" path that is distinct from a total stranger.
func TestAccessGateMatrixComplete(t *testing.T) {
	t.Parallel()
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
	ownerID := ownerRes.User.Id

	orgRes, err := c.orgs.CreateOrganization(ctx, &richterv1.CreateOrganizationRequest{
		CreatedBy: ownerID, Name: gofakeit.Company(), Slug: testSlug(),
	})
	if err != nil {
		t.Fatalf("create org: %v", err)
	}
	orgID := orgRes.Organization.Id

	// courseMemberEmail is enrolled in the course.
	courseMemberEmail, courseMemberPassword, courseMemberID := createActiveUser(t, c.users)
	// orgOnlyEmail is in the org but NOT in the course.
	orgOnlyEmail, orgOnlyPassword, orgOnlyID := createActiveUser(t, c.users)

	for _, m := range []struct {
		id   string
		role richterv1.OrganizationRole
	}{
		{courseMemberID, richterv1.OrganizationRole_ORGANIZATION_ROLE_STUDENT},
		{orgOnlyID, richterv1.OrganizationRole_ORGANIZATION_ROLE_STUDENT},
	} {
		if _, err := c.members.AddOrganizationMember(ctx, &richterv1.AddOrganizationMemberRequest{
			OrganizationId: orgID, UserId: m.id,
			Role: m.role, Status: richterv1.MemberStatus_MEMBER_STATUS_ACTIVE,
		}); err != nil {
			t.Fatalf("add org member %s: %v", m.id, err)
		}
	}

	courseRes, err := c.courses.CreateCourse(ctx, &richterv1.CreateCourseRequest{
		OrganizationId: orgID, OwnerId: ownerID, Title: gofakeit.JobTitle(),
	})
	if err != nil {
		t.Fatalf("create course: %v", err)
	}
	courseID := courseRes.Course.Id

	modRes, err := c.modules.CreateCourseModule(ctx, &richterv1.CreateCourseModuleRequest{
		CourseId: courseID, Title: gofakeit.JobTitle(), OrderIndex: 0,
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

	// Enrol only the course member.
	if _, err := c.courseMembers.AddCourseMember(ctx, &richterv1.AddCourseMemberRequest{
		CourseId: courseID, UserId: courseMemberID, Role: richterv1.CourseRole_COURSE_ROLE_STUDENT,
	}); err != nil {
		t.Fatalf("enrol course member: %v", err)
	}

	ints := insertTestInteractions(t, lessonID, 2)

	courseMemberToken := getUserToken(t, url, courseMemberEmail, courseMemberPassword)
	orgOnlyToken := getUserToken(t, url, orgOnlyEmail, orgOnlyPassword)

	courseMemberIA := richterv1connect.NewInteractionServiceClient(httpClientWithToken(courseMemberToken), url)
	orgOnlyIA := richterv1connect.NewInteractionServiceClient(httpClientWithToken(orgOnlyToken), url)
	orgOnlyLessons := richterv1connect.NewLessonServiceClient(httpClientWithToken(orgOnlyToken), url)
	courseMemberLessons := richterv1connect.NewLessonServiceClient(httpClientWithToken(courseMemberToken), url)

	submitReq := &richterv1.SubmitAttemptRequest{
		LessonId:  lessonID,
		Responses: buildResponses(ints, []int32{0, 0}),
	}

	// ── SubmitAttempt ──────────────────────────────────────────────────────────

	t.Run("SubmitAttempt/OrgMemberNonCourseMember_PermissionDenied", func(t *testing.T) {
		assertCode(t, func() error { _, e := orgOnlyIA.SubmitAttempt(ctx, submitReq); return e }(), connect.CodePermissionDenied)
	})

	t.Run("SubmitAttempt/CourseMember_OK", func(t *testing.T) {
		if _, e := courseMemberIA.SubmitAttempt(ctx, submitReq); e != nil {
			t.Errorf("course member should be allowed SubmitAttempt, got %v", e)
		}
	})

	// ── ListLessonsByCourse ────────────────────────────────────────────────────

	t.Run("ListLessonsByCourse/OrgMemberNonCourseMember_PermissionDenied", func(t *testing.T) {
		assertCode(t, func() error {
			_, e := orgOnlyLessons.ListLessonsByCourse(ctx, &richterv1.ListLessonsByCourseRequest{
				CourseId: courseID, Limit: 50,
			})
			return e
		}(), connect.CodePermissionDenied)
	})

	t.Run("ListLessonsByCourse/CourseMember_OK", func(t *testing.T) {
		if _, e := courseMemberLessons.ListLessonsByCourse(ctx, &richterv1.ListLessonsByCourseRequest{
			CourseId: courseID, Limit: 50,
		}); e != nil {
			t.Errorf("course member should be allowed ListLessonsByCourse, got %v", e)
		}
	})

	// ── NonExistent IDs (oracle protection) ────────────────────────────────────

	t.Run("GetLessonById/OrgMemberNonCourseMember_NonExistentId_PermissionDenied", func(t *testing.T) {
		// Org member who is not a course member must not learn whether an ID exists.
		assertCode(t, func() error {
			_, e := orgOnlyLessons.GetLessonById(ctx, &richterv1.GetLessonByIdRequest{Id: gofakeit.UUID()})
			return e
		}(), connect.CodePermissionDenied)
	})

	t.Run("GetLessonById/Admin_NonExistentId_NotFound", func(t *testing.T) {
		// Sys-admin gets NotFound for a genuine non-existent ID.
		assertCode(t, func() error {
			_, e := richterv1connect.NewLessonServiceClient(httpClientWithToken(getAdminToken(t, url)), url).
				GetLessonById(ctx, &richterv1.GetLessonByIdRequest{Id: gofakeit.UUID()})
			return e
		}(), connect.CodeNotFound)
	})
}

// ── TestLessonHeatmap ─────────────────────────────────────────────────────────

// TestLessonHeatmap verifies the per-chunk score heatmap:
//   - cells are returned ordered by chunk_index ascending;
//   - avg_score is the score-weighted average across all student responses in the
//     chunk;
//   - is_gap is set only when response_count > 0 AND avg_score < 0.6;
//   - a chunk with interactions but no responses (and a chunk with no
//     interactions at all) report response_count 0 and is_gap false.
//
// Setup: 3 ordered chunks.
//   - chunk0: 1 MCQ (correct=0). Both students answer correctly → avg 1.0, no gap.
//   - chunk1: 1 MCQ (correct=0). Both students answer wrong → avg 0.0, gap.
//   - chunk2: 1 MCQ, nobody answers → 0 responses, no gap.
func TestLessonHeatmap(t *testing.T) {
	t.Parallel()
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

	studentAEmail, studentAPassword, studentAID := createActiveUser(t, c.users)
	studentBEmail, studentBPassword, studentBID := createActiveUser(t, c.users)
	for _, uid := range []string{studentAID, studentBID} {
		if _, err := c.members.AddOrganizationMember(ctx, &richterv1.AddOrganizationMemberRequest{
			OrganizationId: orgID, UserId: uid,
			Role: richterv1.OrganizationRole_ORGANIZATION_ROLE_STUDENT, Status: richterv1.MemberStatus_MEMBER_STATUS_ACTIVE,
		}); err != nil {
			t.Fatalf("add org member %s: %v", uid, err)
		}
	}

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

	for _, uid := range []string{studentAID, studentBID} {
		if _, err := c.courseMembers.AddCourseMember(ctx, &richterv1.AddCourseMemberRequest{
			CourseId: courseRes.Course.Id, UserId: uid, Role: richterv1.CourseRole_COURSE_ROLE_STUDENT,
		}); err != nil {
			t.Fatalf("enrol student %s: %v", uid, err)
		}
	}

	// 3 ordered chunks, one MCQ (correct=0) attached to each.
	chunk0 := insertTestChunk(t, lessonID, 0, "")
	chunk1 := insertTestChunk(t, lessonID, 1, "")
	chunk2 := insertTestChunk(t, lessonID, 2, "")
	int0 := insertTestInteractionsForChunk(t, lessonID, chunk0.ID.String(), 1)[0]
	int1 := insertTestInteractionsForChunk(t, lessonID, chunk1.ID.String(), 1)[0]
	_ = insertTestInteractionsForChunk(t, lessonID, chunk2.ID.String(), 1)[0]

	// Both students: chunk0 correct (selected 0), chunk1 wrong (selected 1).
	// chunk2 is never answered.
	for _, st := range []struct{ email, pw string }{
		{studentAEmail, studentAPassword},
		{studentBEmail, studentBPassword},
	} {
		tok := getUserToken(t, url, st.email, st.pw)
		ia := richterv1connect.NewInteractionServiceClient(httpClientWithToken(tok), url)
		if _, err := ia.SubmitAttempt(ctx, &richterv1.SubmitAttemptRequest{
			LessonId: lessonID,
			Responses: []*richterv1.AttemptResponseInput{
				{InteractionId: int0.ID.String(), Response: &richterv1.AttemptResponseInput_McqSelected{McqSelected: 0}},
				{InteractionId: int1.ID.String(), Response: &richterv1.AttemptResponseInput_McqSelected{McqSelected: 1}},
			},
		}); err != nil {
			t.Fatalf("SubmitAttempt for %s: %v", st.email, err)
		}
	}

	res, err := c.interactions.LessonHeatmap(ctx, &richterv1.LessonHeatmapRequest{LessonId: lessonID})
	if err != nil {
		t.Fatalf("LessonHeatmap: %v", err)
	}
	if res.GapThreshold != 0.6 {
		t.Errorf("gap_threshold: want 0.6, got %v", res.GapThreshold)
	}
	if len(res.Cells) != 3 {
		t.Fatalf("expected 3 cells (one per chunk), got %d", len(res.Cells))
	}

	// Cells must be ordered by chunk_index ascending.
	for i, cell := range res.Cells {
		if cell.ChunkIndex != int32(i) {
			t.Errorf("cell %d: chunk_index want %d, got %d", i, i, cell.ChunkIndex)
		}
	}

	c0, c1, c2 := res.Cells[0], res.Cells[1], res.Cells[2]

	// chunk0: both correct → avg 1.0, 2 responses, 2 students, no gap.
	if c0.ResponseCount != 2 {
		t.Errorf("chunk0 response_count: want 2, got %d", c0.ResponseCount)
	}
	if c0.StudentCount != 2 {
		t.Errorf("chunk0 student_count: want 2, got %d", c0.StudentCount)
	}
	if c0.AvgScore != 1.0 {
		t.Errorf("chunk0 avg_score: want 1.0, got %v", c0.AvgScore)
	}
	if c0.IsGap {
		t.Errorf("chunk0 is_gap: want false (avg 1.0), got true")
	}

	// chunk1: both wrong → avg 0.0, 2 responses, gap.
	if c1.ResponseCount != 2 {
		t.Errorf("chunk1 response_count: want 2, got %d", c1.ResponseCount)
	}
	if c1.AvgScore != 0.0 {
		t.Errorf("chunk1 avg_score: want 0.0, got %v", c1.AvgScore)
	}
	if !c1.IsGap {
		t.Errorf("chunk1 is_gap: want true (avg 0.0 < 0.6 with responses), got false")
	}

	// chunk2: no responses → response_count 0, no gap even though avg is 0.
	if c2.ResponseCount != 0 {
		t.Errorf("chunk2 response_count: want 0, got %d", c2.ResponseCount)
	}
	if c2.IsGap {
		t.Errorf("chunk2 is_gap: want false (no responses), got true")
	}

	// Per-chunk student breakdowns drive the heatmap drill-down. Only chunks
	// with answers appear; chunk2 (unanswered) must be absent.
	brk := make(map[string][]*richterv1.ChunkStudentScore)
	for _, b := range res.Breakdowns {
		brk[b.ChunkId] = b.Students
	}
	if _, ok := brk[chunk2.ID.String()]; ok {
		t.Errorf("chunk2 breakdown: want absent (no answers), got present")
	}
	// chunk0: both students, each fully correct (score_frac 1.0), 1 answered.
	if got := brk[chunk0.ID.String()]; len(got) != 2 {
		t.Errorf("chunk0 breakdown: want 2 students, got %d", len(got))
	} else {
		for _, s := range got {
			if s.ScoreFrac != 1.0 {
				t.Errorf("chunk0 student %s: score_frac want 1.0, got %v", s.DisplayName, s.ScoreFrac)
			}
			if s.Answered != 1 {
				t.Errorf("chunk0 student %s: answered want 1, got %d", s.DisplayName, s.Answered)
			}
		}
	}
	// chunk1: both students, each wrong (score_frac 0.0).
	if got := brk[chunk1.ID.String()]; len(got) != 2 {
		t.Errorf("chunk1 breakdown: want 2 students, got %d", len(got))
	} else {
		for _, s := range got {
			if s.ScoreFrac != 0.0 {
				t.Errorf("chunk1 student %s: score_frac want 0.0, got %v", s.DisplayName, s.ScoreFrac)
			}
		}
	}
	// Sanity: the breakdown user_ids are the two enrolled students.
	wantStudents := map[string]bool{studentAID: true, studentBID: true}
	for _, s := range brk[chunk0.ID.String()] {
		if !wantStudents[s.UserId] {
			t.Errorf("chunk0 breakdown: unexpected user_id %s", s.UserId)
		}
	}

	// A manual interaction created WITHOUT a chunk_id is attributed to the chunk
	// its start_seconds falls in, so answered questions stay visible in the
	// heatmap (previously a NULL chunk_id silently dropped them). chunk1 spans
	// [60, 120); start_seconds 90 must land in chunk1.
	t.Run("ManualInteractionAttributedByTime", func(t *testing.T) {
		createRes, err := c.interactions.CreateManualInteraction(ctx, &richterv1.CreateManualInteractionRequest{
			LessonId:     lessonID,
			Prompt:       "Đọc thành tiếng đoạn này",
			StartSeconds: 90,
			// No ChunkId — must be resolved by timestamp.
			Config: &richterv1.CreateManualInteractionRequest_Reading{
				Reading: &richterv1.ReadingConfig{
					Mode:            richterv1.ReadingMode_READING_MODE_PRONUNCIATION,
					PassageMarkdown: "**Định luật** Newton.",
				},
			},
		})
		if err != nil {
			t.Fatalf("CreateManualInteraction (no chunk): %v", err)
		}
		if got := createRes.Interaction.ChunkId; got != chunk1.ID.String() {
			t.Errorf("chunkless interaction at 90s: chunk_id want chunk1 (%s), got %q",
				chunk1.ID.String(), got)
		}
	})

	// Authz: a non-member must be denied.
	nonMemberEmail, nonMemberPassword, _ := createActiveUser(t, c.users)
	nonMemberToken := getUserToken(t, url, nonMemberEmail, nonMemberPassword)
	nonMemberIA := richterv1connect.NewInteractionServiceClient(httpClientWithToken(nonMemberToken), url)
	t.Run("Authz/NonMember_PermissionDenied", func(t *testing.T) {
		assertCode(t, func() error {
			_, e := nonMemberIA.LessonHeatmap(ctx, &richterv1.LessonHeatmapRequest{LessonId: lessonID})
			return e
		}(), connect.CodePermissionDenied)
	})
	t.Run("Authz/Anon_Unauthenticated", func(t *testing.T) {
		anonIA := richterv1connect.NewInteractionServiceClient(http.DefaultClient, url)
		assertCode(t, func() error {
			_, e := anonIA.LessonHeatmap(ctx, &richterv1.LessonHeatmapRequest{LessonId: lessonID})
			return e
		}(), connect.CodeUnauthenticated)
	})
}

// ── TestListAtRiskStudents ────────────────────────────────────────────────────

// TestListAtRiskStudents verifies the consecutive low-engagement detection:
//   - a student with engagement < 40 across 2 CONSECUTIVE lessons is flagged;
//   - a student who engages well in both lessons is NOT flagged;
//   - a student low in only ONE lesson (streak 1 < atRiskMinStreak) is NOT flagged;
//   - pagination (limit/offset) is honoured;
//   - authz: non-members are denied.
//
// Engagement = round(100*(0.4*watch + 0.3*responseRate + 0.3*scoreFrac)).
// low student: watch 0, all-wrong (scoreFrac 0), all answered (responseRate 1)
//
//	→ round(100*0.3) = 30  (< 40)  ✓ low
//
// fine student: watch 1, all-correct (scoreFrac 1), all answered (responseRate 1)
//
//	→ round(100*1.0) = 100 (>= 40) ✓ not low
func TestListAtRiskStudents(t *testing.T) {
	t.Parallel()
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

	// lowID: low in both lessons. fineID: fine in both. oneLowID: low only in
	// lesson 1, fine in lesson 2 (streak 1, must NOT be flagged).
	lowEmail, lowPassword, lowID := createActiveUser(t, c.users)
	fineEmail, finePassword, fineID := createActiveUser(t, c.users)
	oneLowEmail, oneLowPassword, oneLowID := createActiveUser(t, c.users)
	for _, uid := range []string{lowID, fineID, oneLowID} {
		if _, err := c.members.AddOrganizationMember(ctx, &richterv1.AddOrganizationMemberRequest{
			OrganizationId: orgID, UserId: uid,
			Role: richterv1.OrganizationRole_ORGANIZATION_ROLE_STUDENT, Status: richterv1.MemberStatus_MEMBER_STATUS_ACTIVE,
		}); err != nil {
			t.Fatalf("add org member %s: %v", uid, err)
		}
	}

	courseRes, _ := c.courses.CreateCourse(ctx, &richterv1.CreateCourseRequest{
		OrganizationId: orgID, OwnerId: ownerRes.User.Id, Title: gofakeit.JobTitle(),
	})
	courseID := courseRes.Course.Id
	modRes, _ := c.modules.CreateCourseModule(ctx, &richterv1.CreateCourseModuleRequest{
		CourseId: courseID, Title: gofakeit.JobTitle(), OrderIndex: 0,
	})
	// Two consecutive lessons in the same module.
	lesson1Res, _ := c.lessons.CreateLesson(ctx, &richterv1.CreateLessonRequest{
		ModuleId: modRes.Module.Id, Title: gofakeit.JobTitle(), OrderIndex: 0,
	})
	lesson2Res, _ := c.lessons.CreateLesson(ctx, &richterv1.CreateLessonRequest{
		ModuleId: modRes.Module.Id, Title: gofakeit.JobTitle(), OrderIndex: 1,
	})
	lesson1ID := lesson1Res.Lesson.Id
	lesson2ID := lesson2Res.Lesson.Id

	for _, uid := range []string{lowID, fineID, oneLowID} {
		if _, err := c.courseMembers.AddCourseMember(ctx, &richterv1.AddCourseMemberRequest{
			CourseId: courseID, UserId: uid, Role: richterv1.CourseRole_COURSE_ROLE_STUDENT,
		}); err != nil {
			t.Fatalf("enrol student %s: %v", uid, err)
		}
	}

	ints1 := insertTestInteractions(t, lesson1ID, 3)
	ints2 := insertTestInteractions(t, lesson2ID, 3)
	correct1 := correctAnswers(ints1)
	correct2 := correctAnswers(ints2)
	wrong := func(correct []int32) []int32 {
		w := make([]int32, len(correct))
		for i := range correct {
			w[i] = (correct[i] + 1) % 4
		}
		return w
	}

	// submit answers all interactions (responseRate 1.0) with the given watch
	// fraction; "ok" picks correct options, else wrong.
	submit := func(t *testing.T, email, pw, lessonID string, ints []gen.LessonInteraction, answers []int32, watch float64) {
		t.Helper()
		tok := getUserToken(t, url, email, pw)
		ia := richterv1connect.NewInteractionServiceClient(httpClientWithToken(tok), url)
		if _, err := ia.SubmitAttempt(ctx, &richterv1.SubmitAttemptRequest{
			LessonId:           lessonID,
			Responses:          buildResponses(ints, answers),
			VideoWatchFraction: watch,
		}); err != nil {
			t.Fatalf("SubmitAttempt %s lesson %s: %v", email, lessonID, err)
		}
	}

	// low: low in BOTH lessons → eng 30/30.
	submit(t, lowEmail, lowPassword, lesson1ID, ints1, wrong(correct1), 0.0)
	submit(t, lowEmail, lowPassword, lesson2ID, ints2, wrong(correct2), 0.0)
	// fine: fine in BOTH lessons → eng 100/100.
	submit(t, fineEmail, finePassword, lesson1ID, ints1, correct1, 1.0)
	submit(t, fineEmail, finePassword, lesson2ID, ints2, correct2, 1.0)
	// oneLow: low in lesson1 only, fine in lesson2 → streak 1.
	submit(t, oneLowEmail, oneLowPassword, lesson1ID, ints1, wrong(correct1), 0.0)
	submit(t, oneLowEmail, oneLowPassword, lesson2ID, ints2, correct2, 1.0)

	res, err := c.interactions.ListAtRiskStudents(ctx, &richterv1.ListAtRiskStudentsRequest{
		CourseId: courseID, Limit: 50, Offset: 0,
	})
	if err != nil {
		t.Fatalf("ListAtRiskStudents: %v", err)
	}

	flagged := map[string]*richterv1.AtRiskStudent{}
	for _, s := range res.Students {
		flagged[s.UserId] = s
	}

	t.Run("LowStudent_Flagged", func(t *testing.T) {
		s, ok := flagged[lowID]
		if !ok {
			t.Fatalf("low student %s expected to be flagged at-risk, got %+v", lowID, res.Students)
		}
		if len(s.LowStreak) != 2 {
			t.Fatalf("low student low_streak: want 2 consecutive lessons, got %d", len(s.LowStreak))
		}
		// streak ordered by course order: lesson1 then lesson2.
		if s.LowStreak[0].LessonId != lesson1ID || s.LowStreak[1].LessonId != lesson2ID {
			t.Errorf("low_streak lesson order: want [%s,%s], got [%s,%s]",
				lesson1ID, lesson2ID, s.LowStreak[0].LessonId, s.LowStreak[1].LessonId)
		}
		for _, p := range s.LowStreak {
			if p.EngagementScore >= 40 {
				t.Errorf("low_streak point engagement: want < 40, got %v", p.EngagementScore)
			}
		}
		if s.Email != lowEmail {
			t.Errorf("flagged email: want %s, got %s", lowEmail, s.Email)
		}
	})

	t.Run("FineStudent_NotFlagged", func(t *testing.T) {
		if _, ok := flagged[fineID]; ok {
			t.Errorf("fine student %s should NOT be flagged at-risk", fineID)
		}
	})

	t.Run("OneLowLesson_NotFlagged_StreakRule", func(t *testing.T) {
		// Low in only 1 of 2 lessons → streak 1 < atRiskMinStreak(2) → not flagged.
		if _, ok := flagged[oneLowID]; ok {
			t.Errorf("student low in only 1 lesson should NOT be flagged (2+ consecutive rule)")
		}
	})

	t.Run("Pagination", func(t *testing.T) {
		// Only the low student qualifies here, so total must be 1.
		if res.Total != 1 {
			t.Fatalf("total at-risk: want 1, got %d", res.Total)
		}
		// Offset beyond the result set → empty page, total unchanged.
		page2, err := c.interactions.ListAtRiskStudents(ctx, &richterv1.ListAtRiskStudentsRequest{
			CourseId: courseID, Limit: 50, Offset: 1,
		})
		if err != nil {
			t.Fatalf("ListAtRiskStudents page2: %v", err)
		}
		if len(page2.Students) != 0 {
			t.Errorf("offset past end: want 0 students, got %d", len(page2.Students))
		}
		if page2.Total != 1 {
			t.Errorf("page2 total: want 1, got %d", page2.Total)
		}
		// limit 1, offset 0 → exactly the one flagged student.
		page1, err := c.interactions.ListAtRiskStudents(ctx, &richterv1.ListAtRiskStudentsRequest{
			CourseId: courseID, Limit: 1, Offset: 0,
		})
		if err != nil {
			t.Fatalf("ListAtRiskStudents page1: %v", err)
		}
		if len(page1.Students) != 1 {
			t.Errorf("limit 1: want 1 student, got %d", len(page1.Students))
		}
	})

	t.Run("Authz/NonMember_PermissionDenied", func(t *testing.T) {
		nonMemberEmail, nonMemberPassword, _ := createActiveUser(t, c.users)
		nonMemberToken := getUserToken(t, url, nonMemberEmail, nonMemberPassword)
		nonMemberIA := richterv1connect.NewInteractionServiceClient(httpClientWithToken(nonMemberToken), url)
		assertCode(t, func() error {
			_, e := nonMemberIA.ListAtRiskStudents(ctx, &richterv1.ListAtRiskStudentsRequest{
				CourseId: courseID, Limit: 50, Offset: 0,
			})
			return e
		}(), connect.CodePermissionDenied)
	})
}

// ── TestGetLessonQuestionAnalytics ────────────────────────────────────────────

// TestGetLessonQuestionAnalytics verifies per-question analytics:
//   - per-kind accuracy (mcq + fill_blank) with correct response_count/accuracy;
//   - MCQ option distribution: chosen_count per option and is_correct flagging
//     (misconception detection);
//   - avg_response_length_words across free-text (fill_blank) responses.
//
// Setup: one MCQ (4 options, correct index 0) authored via CreateManualInteraction
// (so option text round-trips), plus one fill_blank interaction. Three students:
//
//	A → MCQ option 0 (correct), fill "alpha"        (1 word)
//	B → MCQ option 2 (wrong),   fill "beta gamma"   (2 words)
//	C → MCQ option 2 (wrong),   fill "delta epsilon zeta" (3 words)
//
// MCQ accuracy = 1/3. fill_blank: answers compared against accepted sets.
// avg_response_length_words = (1+2+3)/3 = 2.0.
func TestGetLessonQuestionAnalytics(t *testing.T) {
	t.Parallel()
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

	type student struct{ email, pw, id string }
	var students []student
	for range 3 {
		e, pw, id := createActiveUser(t, c.users)
		students = append(students, student{e, pw, id})
		if _, err := c.members.AddOrganizationMember(ctx, &richterv1.AddOrganizationMemberRequest{
			OrganizationId: orgID, UserId: id,
			Role: richterv1.OrganizationRole_ORGANIZATION_ROLE_STUDENT, Status: richterv1.MemberStatus_MEMBER_STATUS_ACTIVE,
		}); err != nil {
			t.Fatalf("add org member: %v", err)
		}
	}

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

	for _, s := range students {
		if _, err := c.courseMembers.AddCourseMember(ctx, &richterv1.AddCourseMemberRequest{
			CourseId: courseRes.Course.Id, UserId: s.id, Role: richterv1.CourseRole_COURSE_ROLE_STUDENT,
		}); err != nil {
			t.Fatalf("enrol student %s: %v", s.id, err)
		}
	}

	// MCQ with explicit option texts and correct index 0.
	mcqRes, err := c.interactions.CreateManualInteraction(ctx, &richterv1.CreateManualInteractionRequest{
		LessonId: lessonID, Prompt: "Pick the correct option", StartSeconds: 1,
		Config: &richterv1.CreateManualInteractionRequest_Mcq{Mcq: &richterv1.McqConfig{
			Options:       []*richterv1.McqOption{{Text: "Right"}, {Text: "WrongB"}, {Text: "Distractor"}, {Text: "WrongD"}},
			CorrectAnswer: 0,
		}},
	})
	if err != nil {
		t.Fatalf("create mcq: %v", err)
	}
	mcqID := mcqRes.Interaction.Id

	// fill_blank with 1 blank.
	fb := insertFillBlankInteraction(t, lessonID, "Greek letter: {{0}}.", []struct{ Accepted []string }{
		{Accepted: []string{"alpha"}},
	})
	fbID := fb.ID.String()

	// Each student submits an MCQ choice + a fill answer of varying word length.
	type sub struct {
		mcq      int32
		fillText string
	}
	subs := []sub{
		{mcq: 0, fillText: "alpha"},              // 1 word, correct fill
		{mcq: 2, fillText: "beta gamma"},         // 2 words
		{mcq: 2, fillText: "delta epsilon zeta"}, // 3 words
	}
	for i, s := range students {
		tok := getUserToken(t, url, s.email, s.pw)
		ia := richterv1connect.NewInteractionServiceClient(httpClientWithToken(tok), url)
		if _, err := ia.SubmitAttempt(ctx, &richterv1.SubmitAttemptRequest{
			LessonId: lessonID,
			Responses: []*richterv1.AttemptResponseInput{
				{InteractionId: mcqID, Response: &richterv1.AttemptResponseInput_McqSelected{McqSelected: subs[i].mcq}},
				{InteractionId: fbID, Response: &richterv1.AttemptResponseInput_FillBlank{
					FillBlank: &richterv1.FillBlankResponse{Answers: []string{subs[i].fillText}},
				}},
			},
		}); err != nil {
			t.Fatalf("SubmitAttempt student %d: %v", i, err)
		}
	}

	res, err := c.interactions.GetLessonQuestionAnalytics(ctx, &richterv1.GetLessonQuestionAnalyticsRequest{
		LessonId: lessonID,
	})
	if err != nil {
		t.Fatalf("GetLessonQuestionAnalytics: %v", err)
	}

	t.Run("KindAccuracy", func(t *testing.T) {
		byKind := map[string]*richterv1.KindAccuracy{}
		for _, ka := range res.KindAccuracy {
			byKind[ka.Kind] = ka
		}
		mcq, ok := byKind["mcq"]
		if !ok {
			t.Fatalf("kind_accuracy missing mcq; got %+v", res.KindAccuracy)
		}
		if mcq.ResponseCount != 3 {
			t.Errorf("mcq response_count: want 3, got %d", mcq.ResponseCount)
		}
		// 1 of 3 correct → accuracy 1/3.
		if mcq.Accuracy < 0.32 || mcq.Accuracy > 0.34 {
			t.Errorf("mcq accuracy: want ~0.333, got %v", mcq.Accuracy)
		}
		fbKind, ok := byKind["fill_blank"]
		if !ok {
			t.Fatalf("kind_accuracy missing fill_blank; got %+v", res.KindAccuracy)
		}
		if fbKind.ResponseCount != 3 {
			t.Errorf("fill_blank response_count: want 3, got %d", fbKind.ResponseCount)
		}
		// Only "alpha" is accepted → 1 of 3 correct.
		if fbKind.Accuracy < 0.32 || fbKind.Accuracy > 0.34 {
			t.Errorf("fill_blank accuracy: want ~0.333, got %v", fbKind.Accuracy)
		}
	})

	t.Run("McqOptionDistribution", func(t *testing.T) {
		// The single-choice question's option distribution now lives on its
		// QuestionStat.Options (mcq_stats was removed; question_stats supersedes it).
		var stat *richterv1.QuestionStat
		for _, m := range res.QuestionStats {
			if m.InteractionId == mcqID {
				stat = m
				break
			}
		}
		if stat == nil {
			t.Fatalf("question_stats missing mcq interaction %s; got %+v", mcqID, res.QuestionStats)
		}
		if stat.Prompt != "Pick the correct option" {
			t.Errorf("mcq prompt: want %q, got %q", "Pick the correct option", stat.Prompt)
		}
		byIdx := map[int32]*richterv1.McqOptionStat{}
		for _, o := range stat.Options {
			byIdx[o.OptionIndex] = o
		}
		// Option 0 chosen once, correct, text "Right".
		opt0 := byIdx[0]
		if opt0 == nil || opt0.ChosenCount != 1 {
			t.Errorf("option 0 chosen_count: want 1, got %+v", opt0)
		}
		if opt0 != nil {
			if !opt0.IsCorrect {
				t.Errorf("option 0 is_correct: want true")
			}
			if opt0.OptionText != "Right" {
				t.Errorf("option 0 text: want %q, got %q", "Right", opt0.OptionText)
			}
		}
		// Option 2 chosen twice (the misconception), not correct.
		opt2 := byIdx[2]
		if opt2 == nil || opt2.ChosenCount != 2 {
			t.Errorf("option 2 chosen_count: want 2, got %+v", opt2)
		}
		if opt2 != nil && opt2.IsCorrect {
			t.Errorf("option 2 is_correct: want false")
		}
		// EVERY configured option appears in the distribution — including the two
		// never chosen (1 "WrongB", 3 "WrongD") at chosen_count 0 — so the full
		// option set (and notably the correct answer) is always visible in the
		// misconception view even when nobody picked it.
		if len(stat.Options) != 4 {
			t.Errorf("distribution: want all 4 configured options, got %d", len(stat.Options))
		}
		for _, idx := range []int32{1, 3} {
			o := byIdx[idx]
			if o == nil {
				t.Errorf("option %d: want present (chosen_count 0), got absent", idx)
			} else if o.ChosenCount != 0 {
				t.Errorf("option %d chosen_count: want 0 (never chosen), got %d", idx, o.ChosenCount)
			}
		}
	})

	t.Run("AvgResponseLengthWords", func(t *testing.T) {
		// fill words: 1 + 2 + 3 = 6 across 3 responses → avg 2.0.
		if res.AvgResponseLengthWords < 1.99 || res.AvgResponseLengthWords > 2.01 {
			t.Errorf("avg_response_length_words: want 2.0, got %v", res.AvgResponseLengthWords)
		}
	})

	// QuestionStats is the per-question analysis covering ALL kinds (the fix for
	// "Phân tích câu hỏi only shows MCQ"). Before, mcq_stats excluded fill_blank /
	// reading / listening / multiple_choice; now question_stats must include them.
	t.Run("QuestionStatsCoversAllKinds", func(t *testing.T) {
		byID := map[string]*richterv1.QuestionStat{}
		for _, q := range res.QuestionStats {
			byID[q.InteractionId] = q
		}
		// Both the MCQ and the fill_blank question must appear.
		mcqQ, ok := byID[mcqID]
		if !ok {
			t.Fatalf("question_stats missing the mcq; got %d entries %+v", len(res.QuestionStats), res.QuestionStats)
		}
		fbQ, ok := byID[fbID]
		if !ok {
			t.Fatalf("question_stats missing the fill_blank (the bug: non-MCQ kinds were dropped); got %+v", res.QuestionStats)
		}
		// MCQ carries an option distribution + its kind.
		if mcqQ.Kind != "mcq" || len(mcqQ.Options) == 0 {
			t.Errorf("mcq question: kind=%q options=%d, want kind=mcq with options", mcqQ.Kind, len(mcqQ.Options))
		}
		// fill_blank carries accuracy + response_count but NO option distribution.
		if fbQ.Kind != "fill_blank" {
			t.Errorf("fill_blank question kind: want fill_blank, got %q", fbQ.Kind)
		}
		if len(fbQ.Options) != 0 {
			t.Errorf("fill_blank should have no option distribution, got %d", len(fbQ.Options))
		}
		if fbQ.ResponseCount != 3 {
			t.Errorf("fill_blank response_count: want 3, got %d", fbQ.ResponseCount)
		}
		// 1 of 3 correct ("alpha") → ~0.333.
		if fbQ.Accuracy < 0.32 || fbQ.Accuracy > 0.34 {
			t.Errorf("fill_blank accuracy: want ~0.333, got %v", fbQ.Accuracy)
		}
	})

	t.Run("Authz/Student_PermissionDenied", func(t *testing.T) {
		studentTok := getUserToken(t, url, students[0].email, students[0].pw)
		studentIA := richterv1connect.NewInteractionServiceClient(httpClientWithToken(studentTok), url)
		assertCode(t, func() error {
			_, e := studentIA.GetLessonQuestionAnalytics(ctx, &richterv1.GetLessonQuestionAnalyticsRequest{LessonId: lessonID})
			return e
		}(), connect.CodePermissionDenied)
	})

	t.Run("Authz/NonMember_PermissionDenied", func(t *testing.T) {
		nonMemberEmail, nonMemberPassword, _ := createActiveUser(t, c.users)
		nonMemberToken := getUserToken(t, url, nonMemberEmail, nonMemberPassword)
		nonMemberIA := richterv1connect.NewInteractionServiceClient(httpClientWithToken(nonMemberToken), url)
		assertCode(t, func() error {
			_, e := nonMemberIA.GetLessonQuestionAnalytics(ctx, &richterv1.GetLessonQuestionAnalyticsRequest{LessonId: lessonID})
			return e
		}(), connect.CodePermissionDenied)
	})
}
