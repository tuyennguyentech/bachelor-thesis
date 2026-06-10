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
			AudioObjectKey:  "lessons/" + lessonID + "/audio/manual.mp3",
			DurationSeconds: 3,
			Mode:            richterv1.ListeningMode_LISTENING_MODE_COMPREHENSION,
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
				AudioObjectKey: "lessons/test/audio.mp3",
				Mode:           richterv1.ListeningMode_LISTENING_MODE_COMPREHENSION,
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

func TestDeleteLessonInteractionsBulk(t *testing.T) {
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

	createMCQ := func(t *testing.T, chunkID string) {
		t.Helper()
		_, err := teacherInteractions.CreateManualInteraction(ctx, &richterv1.CreateManualInteractionRequest{
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
			t.Fatalf("create interaction: %v", err)
		}
	}

	createMCQ(t, chunkA.ID.String())
	createMCQ(t, chunkA.ID.String())
	createMCQ(t, chunkB.ID.String())
	createMCQ(t, "")

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
