//go:build integ

package v1

import (
	"context"
	"net/http"
	"testing"

	"connectrpc.com/connect"
	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/buf/gen/richter/v1/richterv1connect"
	"github.com/brianvoe/gofakeit/v7"
)

// ── shared test client struct ─────────────────────────────────────────────────

type coursesTestClients struct {
	courses richterv1connect.CourseServiceClient
	modules richterv1connect.CourseModuleServiceClient
	lessons richterv1connect.LessonServiceClient
	orgs    richterv1connect.OrganizationServiceClient
	members richterv1connect.OrganizationMemberServiceClient
	users   richterv1connect.UserServiceClient
}

func setupCoursesTestClients(t *testing.T) coursesTestClients {
	t.Helper()
	url := newV1Server(t)
	adminToken := getAdminToken(t, url)
	return coursesTestClients{
		courses: richterv1connect.NewCourseServiceClient(httpClientWithToken(adminToken), url),
		modules: richterv1connect.NewCourseModuleServiceClient(httpClientWithToken(adminToken), url),
		lessons: richterv1connect.NewLessonServiceClient(httpClientWithToken(adminToken), url),
		orgs:    richterv1connect.NewOrganizationServiceClient(httpClientWithToken(adminToken), url),
		members: richterv1connect.NewOrganizationMemberServiceClient(httpClientWithToken(adminToken), url),
		users:   richterv1connect.NewUserServiceClient(httpClientWithToken(adminToken), url),
	}
}

// ── setup helpers ─────────────────────────────────────────────────────────────

func createTestOrgForCourses(t *testing.T, c coursesTestClients, ownerID string) string {
	t.Helper()
	res, err := c.orgs.CreateOrganization(context.Background(), &richterv1.CreateOrganizationRequest{
		CreatedBy: ownerID,
		Name:      gofakeit.Company(),
		Slug:      testSlug(),
	})
	if err != nil {
		t.Fatalf("setup: create org: %v", err)
	}
	return res.Organization.Id
}

func createTestCourse(t *testing.T, c coursesTestClients, orgID, ownerID string) string {
	t.Helper()
	res, err := c.courses.CreateCourse(context.Background(), &richterv1.CreateCourseRequest{
		OrganizationId: orgID,
		OwnerId:        ownerID,
		Title:          gofakeit.JobTitle(),
	})
	if err != nil {
		t.Fatalf("setup: create course: %v", err)
	}
	return res.Course.Id
}

func createTestModule(t *testing.T, c coursesTestClients, courseID string, order int32) string {
	t.Helper()
	res, err := c.modules.CreateCourseModule(context.Background(), &richterv1.CreateCourseModuleRequest{
		CourseId:   courseID,
		Title:      gofakeit.JobTitle(),
		OrderIndex: order,
	})
	if err != nil {
		t.Fatalf("setup: create module: %v", err)
	}
	return res.Module.Id
}

func createTestLesson(t *testing.T, c coursesTestClients, moduleID string, order int32) string {
	t.Helper()
	res, err := c.lessons.CreateLesson(context.Background(), &richterv1.CreateLessonRequest{
		ModuleId:   moduleID,
		Title:      gofakeit.JobTitle(),
		OrderIndex: order,
	})
	if err != nil {
		t.Fatalf("setup: create lesson: %v", err)
	}
	return res.Lesson.Id
}

// ── CourseService ─────────────────────────────────────────────────────────────

func TestCourseValidation(t *testing.T) {
	c := setupCoursesTestClients(t)
	ctx := t.Context()
	_, _, userID := createActiveUser(t, c.users)
	orgID := createTestOrgForCourses(t, c, userID)

	tests := []struct {
		name string
		req  *richterv1.CreateCourseRequest
	}{
		{
			name: "InvalidOrgUUID",
			req:  &richterv1.CreateCourseRequest{OrganizationId: "not-a-uuid", OwnerId: userID, Title: "X"},
		},
		{
			name: "InvalidOwnerUUID",
			req:  &richterv1.CreateCourseRequest{OrganizationId: orgID, OwnerId: "not-a-uuid", Title: "X"},
		},
		{
			name: "EmptyTitle",
			req:  &richterv1.CreateCourseRequest{OrganizationId: orgID, OwnerId: userID, Title: ""},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := c.courses.CreateCourse(ctx, tt.req)
			assertCode(t, err, connect.CodeInvalidArgument)
		})
	}
}

func TestCourseLifecycle(t *testing.T) {
	c := setupCoursesTestClients(t)
	ctx := t.Context()
	_, _, ownerID := createActiveUser(t, c.users)
	orgID := createTestOrgForCourses(t, c, ownerID)

	title := gofakeit.JobTitle()
	description := gofakeit.Sentence(8)
	var courseID string

	t.Run("CreateCourse", func(t *testing.T) {
		res, err := c.courses.CreateCourse(ctx, &richterv1.CreateCourseRequest{
			OrganizationId: orgID,
			OwnerId:        ownerID,
			Title:          title,
			Description:    description,
		})
		if err != nil {
			t.Fatalf("create course: %v", err)
		}
		if res.Course.Title != title {
			t.Errorf("expected title %q, got %q", title, res.Course.Title)
		}
		if res.Course.Description != description {
			t.Errorf("expected description %q, got %q", description, res.Course.Description)
		}
		if res.Course.Status != richterv1.CourseStatus_COURSE_STATUS_DRAFT {
			t.Errorf("expected status DRAFT, got %v", res.Course.Status)
		}
		if res.Course.OrganizationId != orgID {
			t.Errorf("expected org %s, got %s", orgID, res.Course.OrganizationId)
		}
		courseID = res.Course.Id
	})

	t.Run("GetCourseById", func(t *testing.T) {
		res, err := c.courses.GetCourseById(ctx, &richterv1.GetCourseByIdRequest{Id: courseID})
		if err != nil {
			t.Fatalf("get course: %v", err)
		}
		if res.Course.Id != courseID {
			t.Errorf("expected id %s, got %s", courseID, res.Course.Id)
		}
	})

	t.Run("ListCourses", func(t *testing.T) {
		res, err := c.courses.ListCourses(ctx, &richterv1.ListCoursesRequest{
			OrganizationId: orgID,
			Limit:          10,
		})
		if err != nil {
			t.Fatalf("list courses: %v", err)
		}
		found := false
		for _, course := range res.Courses {
			if course.Id == courseID {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("course %s not found in list", courseID)
		}
	})

	t.Run("ListCoursesByStatus", func(t *testing.T) {
		res, err := c.courses.ListCourses(ctx, &richterv1.ListCoursesRequest{
			OrganizationId: orgID,
			Limit:          10,
			StatusFilter:   richterv1.CourseStatus_COURSE_STATUS_DRAFT.Enum(),
		})
		if err != nil {
			t.Fatalf("list courses by status: %v", err)
		}
		found := false
		for _, course := range res.Courses {
			if course.Id == courseID {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("course %s not found in draft filter", courseID)
		}
	})

	t.Run("UpdateCourse", func(t *testing.T) {
		newTitle := gofakeit.JobTitle()
		res, err := c.courses.UpdateCourse(ctx, &richterv1.UpdateCourseRequest{
			Id:    courseID,
			Title: newTitle,
		})
		if err != nil {
			t.Fatalf("update course: %v", err)
		}
		if res.Course.Title != newTitle {
			t.Errorf("expected title %q, got %q", newTitle, res.Course.Title)
		}
	})

	t.Run("UpdateCourseStatus", func(t *testing.T) {
		res, err := c.courses.UpdateCourseStatus(ctx, &richterv1.UpdateCourseStatusRequest{
			Id:     courseID,
			Status: richterv1.CourseStatus_COURSE_STATUS_PUBLISHED,
		})
		if err != nil {
			t.Fatalf("update course status: %v", err)
		}
		if res.Course.Status != richterv1.CourseStatus_COURSE_STATUS_PUBLISHED {
			t.Errorf("expected status PUBLISHED, got %v", res.Course.Status)
		}
	})

	t.Run("DeleteCourse", func(t *testing.T) {
		_, err := c.courses.DeleteCourse(ctx, &richterv1.DeleteCourseRequest{Id: courseID})
		if err != nil {
			t.Fatalf("delete course: %v", err)
		}
	})

	t.Run("VerifyDeleted", func(t *testing.T) {
		_, err := c.courses.GetCourseById(ctx, &richterv1.GetCourseByIdRequest{Id: courseID})
		assertCode(t, err, connect.CodeNotFound)
	})
}

func TestCourseErrors(t *testing.T) {
	c := setupCoursesTestClients(t)
	ctx := t.Context()

	t.Run("GetNotFound", func(t *testing.T) {
		_, err := c.courses.GetCourseById(ctx, &richterv1.GetCourseByIdRequest{Id: gofakeit.UUID()})
		assertCode(t, err, connect.CodeNotFound)
	})

	t.Run("UpdateNotFound", func(t *testing.T) {
		_, err := c.courses.UpdateCourse(ctx, &richterv1.UpdateCourseRequest{
			Id:    gofakeit.UUID(),
			Title: "X",
		})
		assertCode(t, err, connect.CodeNotFound)
	})

	t.Run("DeleteNotFound", func(t *testing.T) {
		_, err := c.courses.DeleteCourse(ctx, &richterv1.DeleteCourseRequest{Id: gofakeit.UUID()})
		assertCode(t, err, connect.CodeNotFound)
	})
}

func TestCoursesAuthz(t *testing.T) {
	url := newV1Server(t)
	ctx := context.Background()
	adminToken := getAdminToken(t, url)

	adminUsers := richterv1connect.NewUserServiceClient(httpClientWithToken(adminToken), url)
	adminOrgs := richterv1connect.NewOrganizationServiceClient(httpClientWithToken(adminToken), url)
	adminMembers := richterv1connect.NewOrganizationMemberServiceClient(httpClientWithToken(adminToken), url)
	adminCourses := richterv1connect.NewCourseServiceClient(httpClientWithToken(adminToken), url)

	anonCourses := richterv1connect.NewCourseServiceClient(http.DefaultClient, url)

	ownerEmail, ownerPass, ownerID := createActiveUser(t, adminUsers)
	ownerToken := getUserToken(t, url, ownerEmail, ownerPass)

	orgAdminEmail, orgAdminPass, orgAdminID := createActiveUser(t, adminUsers)
	orgAdminToken := getUserToken(t, url, orgAdminEmail, orgAdminPass)

	teacherEmail, teacherPass, teacherID := createActiveUser(t, adminUsers)
	teacherToken := getUserToken(t, url, teacherEmail, teacherPass)

	studentEmail, studentPass, studentID := createActiveUser(t, adminUsers)
	studentToken := getUserToken(t, url, studentEmail, studentPass)

	nonMemberEmail, nonMemberPass, _ := createActiveUser(t, adminUsers)
	nonMemberToken := getUserToken(t, url, nonMemberEmail, nonMemberPass)

	// create org — owner becomes OWNER automatically
	orgRes, err := richterv1connect.NewOrganizationServiceClient(httpClientWithToken(ownerToken), url).
		CreateOrganization(ctx, &richterv1.CreateOrganizationRequest{
			CreatedBy: ownerID,
			Name:      gofakeit.Company(),
			Slug:      testSlug(),
		})
	if err != nil {
		t.Fatalf("setup: create org: %v", err)
	}
	orgID := orgRes.Organization.Id

	// add members
	for _, m := range []struct {
		id   string
		role richterv1.OrganizationRole
	}{
		{orgAdminID, richterv1.OrganizationRole_ORGANIZATION_ROLE_ADMIN},
		{teacherID, richterv1.OrganizationRole_ORGANIZATION_ROLE_TEACHER},
		{studentID, richterv1.OrganizationRole_ORGANIZATION_ROLE_STUDENT},
	} {
		if _, err := adminMembers.AddOrganizationMember(ctx, &richterv1.AddOrganizationMemberRequest{
			OrganizationId: orgID, UserId: m.id,
			Role: m.role, Status: richterv1.MemberStatus_MEMBER_STATUS_ACTIVE,
		}); err != nil {
			t.Fatalf("setup: add member: %v", err)
		}
	}

	ownerCourses := richterv1connect.NewCourseServiceClient(httpClientWithToken(ownerToken), url)
	orgAdminCourses := richterv1connect.NewCourseServiceClient(httpClientWithToken(orgAdminToken), url)
	teacherCourses := richterv1connect.NewCourseServiceClient(httpClientWithToken(teacherToken), url)
	studentCourses := richterv1connect.NewCourseServiceClient(httpClientWithToken(studentToken), url)
	nonMemberCourses := richterv1connect.NewCourseServiceClient(httpClientWithToken(nonMemberToken), url)

	// create a course for mutation tests
	courseRes, err := adminCourses.CreateCourse(ctx, &richterv1.CreateCourseRequest{
		OrganizationId: orgID,
		OwnerId:        ownerID,
		Title:          gofakeit.JobTitle(),
	})
	if err != nil {
		t.Fatalf("setup: create course: %v", err)
	}
	courseID := courseRes.Course.Id

	// --- CreateCourse ---
	t.Run("CreateCourse", func(t *testing.T) {
		newCourse := func() *richterv1.CreateCourseRequest {
			return &richterv1.CreateCourseRequest{OrganizationId: orgID, OwnerId: ownerID, Title: gofakeit.JobTitle()}
		}
		t.Run("Anon/Unauthenticated", func(t *testing.T) {
			assertCode(t, func() error { _, e := anonCourses.CreateCourse(ctx, newCourse()); return e }(), connect.CodeUnauthenticated)
		})
		t.Run("NonMember/PermissionDenied", func(t *testing.T) {
			assertCode(t, func() error { _, e := nonMemberCourses.CreateCourse(ctx, newCourse()); return e }(), connect.CodePermissionDenied)
		})
		t.Run("Student/PermissionDenied", func(t *testing.T) {
			assertCode(t, func() error { _, e := studentCourses.CreateCourse(ctx, newCourse()); return e }(), connect.CodePermissionDenied)
		})
		t.Run("Teacher/OK", func(t *testing.T) {
			if _, err := teacherCourses.CreateCourse(ctx, newCourse()); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
		t.Run("OrgAdmin/OK", func(t *testing.T) {
			if _, err := orgAdminCourses.CreateCourse(ctx, newCourse()); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
		t.Run("Owner/OK", func(t *testing.T) {
			if _, err := ownerCourses.CreateCourse(ctx, newCourse()); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
	})

	// --- GetCourseById ---
	t.Run("GetCourseById", func(t *testing.T) {
		req := &richterv1.GetCourseByIdRequest{Id: courseID}
		t.Run("Anon/Unauthenticated", func(t *testing.T) {
			assertCode(t, func() error { _, e := anonCourses.GetCourseById(ctx, req); return e }(), connect.CodeUnauthenticated)
		})
		t.Run("AnyAuthed/OK", func(t *testing.T) {
			if _, err := nonMemberCourses.GetCourseById(ctx, req); err != nil {
				t.Errorf("expected OK for any authenticated user, got %v", err)
			}
		})
		t.Run("Student/OK", func(t *testing.T) {
			if _, err := studentCourses.GetCourseById(ctx, req); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
	})

	// --- ListCourses ---
	t.Run("ListCourses", func(t *testing.T) {
		req := &richterv1.ListCoursesRequest{OrganizationId: orgID, Limit: 10}
		t.Run("Anon/Unauthenticated", func(t *testing.T) {
			assertCode(t, func() error { _, e := anonCourses.ListCourses(ctx, req); return e }(), connect.CodeUnauthenticated)
		})
		t.Run("NonMember/PermissionDenied", func(t *testing.T) {
			assertCode(t, func() error { _, e := nonMemberCourses.ListCourses(ctx, req); return e }(), connect.CodePermissionDenied)
		})
		t.Run("Student/OK", func(t *testing.T) {
			if _, err := studentCourses.ListCourses(ctx, req); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
		t.Run("Teacher/OK", func(t *testing.T) {
			if _, err := teacherCourses.ListCourses(ctx, req); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
	})

	// --- UpdateCourse ---
	updateReq := &richterv1.UpdateCourseRequest{Id: courseID, Title: gofakeit.JobTitle()}
	t.Run("UpdateCourse", func(t *testing.T) {
		t.Run("Anon/Unauthenticated", func(t *testing.T) {
			assertCode(t, func() error { _, e := anonCourses.UpdateCourse(ctx, updateReq); return e }(), connect.CodeUnauthenticated)
		})
		t.Run("NonMember/PermissionDenied", func(t *testing.T) {
			assertCode(t, func() error { _, e := nonMemberCourses.UpdateCourse(ctx, updateReq); return e }(), connect.CodePermissionDenied)
		})
		t.Run("Student/PermissionDenied", func(t *testing.T) {
			assertCode(t, func() error { _, e := studentCourses.UpdateCourse(ctx, updateReq); return e }(), connect.CodePermissionDenied)
		})
		t.Run("Teacher/OK", func(t *testing.T) {
			if _, err := teacherCourses.UpdateCourse(ctx, updateReq); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
		t.Run("OrgAdmin/OK", func(t *testing.T) {
			if _, err := orgAdminCourses.UpdateCourse(ctx, updateReq); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
		t.Run("Owner/OK", func(t *testing.T) {
			if _, err := ownerCourses.UpdateCourse(ctx, updateReq); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
	})

	// --- UpdateCourseStatus --- (Owner|Admin only, Teacher is denied)
	statusReq := &richterv1.UpdateCourseStatusRequest{Id: courseID, Status: richterv1.CourseStatus_COURSE_STATUS_PUBLISHED}
	t.Run("UpdateCourseStatus", func(t *testing.T) {
		t.Run("Anon/Unauthenticated", func(t *testing.T) {
			assertCode(t, func() error { _, e := anonCourses.UpdateCourseStatus(ctx, statusReq); return e }(), connect.CodeUnauthenticated)
		})
		t.Run("Student/PermissionDenied", func(t *testing.T) {
			assertCode(t, func() error { _, e := studentCourses.UpdateCourseStatus(ctx, statusReq); return e }(), connect.CodePermissionDenied)
		})
		t.Run("Teacher/PermissionDenied", func(t *testing.T) {
			assertCode(t, func() error { _, e := teacherCourses.UpdateCourseStatus(ctx, statusReq); return e }(), connect.CodePermissionDenied)
		})
		t.Run("OrgAdmin/OK", func(t *testing.T) {
			if _, err := orgAdminCourses.UpdateCourseStatus(ctx, statusReq); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
		t.Run("Owner/OK", func(t *testing.T) {
			if _, err := ownerCourses.UpdateCourseStatus(ctx, statusReq); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
	})

	// --- DeleteCourse --- (Owner|Admin only)
	t.Run("DeleteCourse", func(t *testing.T) {
		makeDisposableCourse := func(t *testing.T) string {
			t.Helper()
			res, err := adminCourses.CreateCourse(ctx, &richterv1.CreateCourseRequest{
				OrganizationId: orgID, OwnerId: ownerID, Title: gofakeit.JobTitle(),
			})
			if err != nil {
				t.Fatalf("setup: create disposable course: %v", err)
			}
			return res.Course.Id
		}

		t.Run("Anon/Unauthenticated", func(t *testing.T) {
			assertCode(t, func() error {
				_, e := anonCourses.DeleteCourse(ctx, &richterv1.DeleteCourseRequest{Id: makeDisposableCourse(t)})
				return e
			}(), connect.CodeUnauthenticated)
		})
		t.Run("Student/PermissionDenied", func(t *testing.T) {
			assertCode(t, func() error {
				_, e := studentCourses.DeleteCourse(ctx, &richterv1.DeleteCourseRequest{Id: makeDisposableCourse(t)})
				return e
			}(), connect.CodePermissionDenied)
		})
		t.Run("Teacher/PermissionDenied", func(t *testing.T) {
			assertCode(t, func() error {
				_, e := teacherCourses.DeleteCourse(ctx, &richterv1.DeleteCourseRequest{Id: makeDisposableCourse(t)})
				return e
			}(), connect.CodePermissionDenied)
		})
		t.Run("OrgAdmin/OK", func(t *testing.T) {
			if _, err := orgAdminCourses.DeleteCourse(ctx, &richterv1.DeleteCourseRequest{Id: makeDisposableCourse(t)}); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
		t.Run("Owner/OK", func(t *testing.T) {
			if _, err := ownerCourses.DeleteCourse(ctx, &richterv1.DeleteCourseRequest{Id: makeDisposableCourse(t)}); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
	})

	_ = adminOrgs
}

// ── CourseModuleService ───────────────────────────────────────────────────────

func TestCourseModuleValidation(t *testing.T) {
	c := setupCoursesTestClients(t)
	ctx := t.Context()
	_, _, ownerID := createActiveUser(t, c.users)
	orgID := createTestOrgForCourses(t, c, ownerID)
	courseID := createTestCourse(t, c, orgID, ownerID)

	tests := []struct {
		name string
		req  *richterv1.CreateCourseModuleRequest
	}{
		{
			name: "InvalidCourseUUID",
			req:  &richterv1.CreateCourseModuleRequest{CourseId: "not-a-uuid", Title: "X", OrderIndex: 0},
		},
		{
			name: "EmptyTitle",
			req:  &richterv1.CreateCourseModuleRequest{CourseId: courseID, Title: "", OrderIndex: 0},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := c.modules.CreateCourseModule(ctx, tt.req)
			assertCode(t, err, connect.CodeInvalidArgument)
		})
	}
}

func TestCourseModuleLifecycle(t *testing.T) {
	c := setupCoursesTestClients(t)
	ctx := t.Context()
	_, _, ownerID := createActiveUser(t, c.users)
	orgID := createTestOrgForCourses(t, c, ownerID)
	courseID := createTestCourse(t, c, orgID, ownerID)

	title := gofakeit.JobTitle()
	var moduleID string

	t.Run("CreateCourseModule", func(t *testing.T) {
		res, err := c.modules.CreateCourseModule(ctx, &richterv1.CreateCourseModuleRequest{
			CourseId:   courseID,
			Title:      title,
			OrderIndex: 0,
		})
		if err != nil {
			t.Fatalf("create module: %v", err)
		}
		if res.Module.Title != title {
			t.Errorf("expected title %q, got %q", title, res.Module.Title)
		}
		if res.Module.CourseId != courseID {
			t.Errorf("expected course_id %s, got %s", courseID, res.Module.CourseId)
		}
		if res.Module.OrderIndex != 0 {
			t.Errorf("expected order_index 0, got %d", res.Module.OrderIndex)
		}
		moduleID = res.Module.Id
	})

	t.Run("GetCourseModuleById", func(t *testing.T) {
		res, err := c.modules.GetCourseModuleById(ctx, &richterv1.GetCourseModuleByIdRequest{Id: moduleID})
		if err != nil {
			t.Fatalf("get module: %v", err)
		}
		if res.Module.Id != moduleID {
			t.Errorf("expected id %s, got %s", moduleID, res.Module.Id)
		}
	})

	t.Run("ListCourseModules", func(t *testing.T) {
		res, err := c.modules.ListCourseModules(ctx, &richterv1.ListCourseModulesRequest{CourseId: courseID, Limit: 50})
		if err != nil {
			t.Fatalf("list modules: %v", err)
		}
		found := false
		for _, m := range res.Modules {
			if m.Id == moduleID {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("module %s not found in list", moduleID)
		}
	})

	t.Run("UpdateCourseModule", func(t *testing.T) {
		newTitle := gofakeit.JobTitle()
		res, err := c.modules.UpdateCourseModule(ctx, &richterv1.UpdateCourseModuleRequest{
			Id:         moduleID,
			Title:      newTitle,
			OrderIndex: 1,
		})
		if err != nil {
			t.Fatalf("update module: %v", err)
		}
		if res.Module.Title != newTitle {
			t.Errorf("expected title %q, got %q", newTitle, res.Module.Title)
		}
		if res.Module.OrderIndex != 1 {
			t.Errorf("expected order_index 1, got %d", res.Module.OrderIndex)
		}
	})

	t.Run("DeleteCourseModule", func(t *testing.T) {
		_, err := c.modules.DeleteCourseModule(ctx, &richterv1.DeleteCourseModuleRequest{Id: moduleID})
		if err != nil {
			t.Fatalf("delete module: %v", err)
		}
	})

	t.Run("VerifyDeleted", func(t *testing.T) {
		_, err := c.modules.GetCourseModuleById(ctx, &richterv1.GetCourseModuleByIdRequest{Id: moduleID})
		assertCode(t, err, connect.CodeNotFound)
	})
}

func TestCourseModuleErrors(t *testing.T) {
	c := setupCoursesTestClients(t)
	ctx := t.Context()

	t.Run("GetNotFound", func(t *testing.T) {
		_, err := c.modules.GetCourseModuleById(ctx, &richterv1.GetCourseModuleByIdRequest{Id: gofakeit.UUID()})
		assertCode(t, err, connect.CodeNotFound)
	})

	t.Run("UpdateNotFound", func(t *testing.T) {
		_, err := c.modules.UpdateCourseModule(ctx, &richterv1.UpdateCourseModuleRequest{
			Id: gofakeit.UUID(), Title: "X", OrderIndex: 0,
		})
		assertCode(t, err, connect.CodeNotFound)
	})

	t.Run("DeleteNotFound", func(t *testing.T) {
		_, err := c.modules.DeleteCourseModule(ctx, &richterv1.DeleteCourseModuleRequest{Id: gofakeit.UUID()})
		assertCode(t, err, connect.CodeNotFound)
	})
}

func TestCourseModulesAuthz(t *testing.T) {
	url := newV1Server(t)
	ctx := context.Background()
	adminToken := getAdminToken(t, url)

	adminUsers := richterv1connect.NewUserServiceClient(httpClientWithToken(adminToken), url)
	adminMembers := richterv1connect.NewOrganizationMemberServiceClient(httpClientWithToken(adminToken), url)
	adminCourses := richterv1connect.NewCourseServiceClient(httpClientWithToken(adminToken), url)
	adminModules := richterv1connect.NewCourseModuleServiceClient(httpClientWithToken(adminToken), url)
	anonModules := richterv1connect.NewCourseModuleServiceClient(http.DefaultClient, url)

	ownerEmail, ownerPass, ownerID := createActiveUser(t, adminUsers)
	ownerToken := getUserToken(t, url, ownerEmail, ownerPass)

	teacherEmail, teacherPass, teacherID := createActiveUser(t, adminUsers)
	teacherToken := getUserToken(t, url, teacherEmail, teacherPass)

	studentEmail, studentPass, studentID := createActiveUser(t, adminUsers)
	studentToken := getUserToken(t, url, studentEmail, studentPass)

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
	courseID := courseRes.Course.Id
	moduleID := createTestModule(t,
		coursesTestClients{modules: adminModules},
		courseID, 0)

	ownerModules := richterv1connect.NewCourseModuleServiceClient(httpClientWithToken(ownerToken), url)
	teacherModules := richterv1connect.NewCourseModuleServiceClient(httpClientWithToken(teacherToken), url)
	studentModules := richterv1connect.NewCourseModuleServiceClient(httpClientWithToken(studentToken), url)
	nonMemberModules := richterv1connect.NewCourseModuleServiceClient(httpClientWithToken(nonMemberToken), url)

	// --- CreateCourseModule ---
	t.Run("CreateCourseModule", func(t *testing.T) {
		req := func() *richterv1.CreateCourseModuleRequest {
			return &richterv1.CreateCourseModuleRequest{CourseId: courseID, Title: gofakeit.JobTitle(), OrderIndex: 99}
		}
		t.Run("Anon/Unauthenticated", func(t *testing.T) {
			assertCode(t, func() error { _, e := anonModules.CreateCourseModule(ctx, req()); return e }(), connect.CodeUnauthenticated)
		})
		t.Run("NonMember/PermissionDenied", func(t *testing.T) {
			assertCode(t, func() error { _, e := nonMemberModules.CreateCourseModule(ctx, req()); return e }(), connect.CodePermissionDenied)
		})
		t.Run("Student/PermissionDenied", func(t *testing.T) {
			assertCode(t, func() error { _, e := studentModules.CreateCourseModule(ctx, req()); return e }(), connect.CodePermissionDenied)
		})
		t.Run("Teacher/OK", func(t *testing.T) {
			if _, err := teacherModules.CreateCourseModule(ctx, req()); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
		t.Run("Owner/OK", func(t *testing.T) {
			if _, err := ownerModules.CreateCourseModule(ctx, req()); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
	})

	// --- GetCourseModuleById ---
	t.Run("GetCourseModuleById", func(t *testing.T) {
		req := &richterv1.GetCourseModuleByIdRequest{Id: moduleID}
		t.Run("Anon/Unauthenticated", func(t *testing.T) {
			assertCode(t, func() error { _, e := anonModules.GetCourseModuleById(ctx, req); return e }(), connect.CodeUnauthenticated)
		})
		t.Run("Student/OK", func(t *testing.T) {
			if _, err := studentModules.GetCourseModuleById(ctx, req); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
	})

	// --- ListCourseModules ---
	t.Run("ListCourseModules", func(t *testing.T) {
		req := &richterv1.ListCourseModulesRequest{CourseId: courseID, Limit: 50}
		t.Run("Anon/Unauthenticated", func(t *testing.T) {
			assertCode(t, func() error { _, e := anonModules.ListCourseModules(ctx, req); return e }(), connect.CodeUnauthenticated)
		})
		t.Run("NonMember/OK", func(t *testing.T) {
			if _, err := nonMemberModules.ListCourseModules(ctx, req); err != nil {
				t.Errorf("expected OK for any authenticated user, got %v", err)
			}
		})
	})

	// --- UpdateCourseModule ---
	t.Run("UpdateCourseModule", func(t *testing.T) {
		req := &richterv1.UpdateCourseModuleRequest{Id: moduleID, Title: gofakeit.JobTitle(), OrderIndex: 0}
		t.Run("Anon/Unauthenticated", func(t *testing.T) {
			assertCode(t, func() error { _, e := anonModules.UpdateCourseModule(ctx, req); return e }(), connect.CodeUnauthenticated)
		})
		t.Run("NonMember/PermissionDenied", func(t *testing.T) {
			assertCode(t, func() error { _, e := nonMemberModules.UpdateCourseModule(ctx, req); return e }(), connect.CodePermissionDenied)
		})
		t.Run("Student/PermissionDenied", func(t *testing.T) {
			assertCode(t, func() error { _, e := studentModules.UpdateCourseModule(ctx, req); return e }(), connect.CodePermissionDenied)
		})
		t.Run("Teacher/OK", func(t *testing.T) {
			if _, err := teacherModules.UpdateCourseModule(ctx, req); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
	})

	// --- DeleteCourseModule ---
	t.Run("DeleteCourseModule", func(t *testing.T) {
		makeDisposableModule := func(t *testing.T) string {
			t.Helper()
			res, err := adminModules.CreateCourseModule(ctx, &richterv1.CreateCourseModuleRequest{
				CourseId: courseID, Title: gofakeit.JobTitle(), OrderIndex: 99,
			})
			if err != nil {
				t.Fatalf("setup: create disposable module: %v", err)
			}
			return res.Module.Id
		}
		t.Run("Anon/Unauthenticated", func(t *testing.T) {
			assertCode(t, func() error {
				_, e := anonModules.DeleteCourseModule(ctx, &richterv1.DeleteCourseModuleRequest{Id: makeDisposableModule(t)})
				return e
			}(), connect.CodeUnauthenticated)
		})
		t.Run("NonMember/PermissionDenied", func(t *testing.T) {
			assertCode(t, func() error {
				_, e := nonMemberModules.DeleteCourseModule(ctx, &richterv1.DeleteCourseModuleRequest{Id: makeDisposableModule(t)})
				return e
			}(), connect.CodePermissionDenied)
		})
		t.Run("Student/PermissionDenied", func(t *testing.T) {
			assertCode(t, func() error {
				_, e := studentModules.DeleteCourseModule(ctx, &richterv1.DeleteCourseModuleRequest{Id: makeDisposableModule(t)})
				return e
			}(), connect.CodePermissionDenied)
		})
		t.Run("Teacher/OK", func(t *testing.T) {
			if _, err := teacherModules.DeleteCourseModule(ctx, &richterv1.DeleteCourseModuleRequest{Id: makeDisposableModule(t)}); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
		t.Run("Owner/OK", func(t *testing.T) {
			if _, err := ownerModules.DeleteCourseModule(ctx, &richterv1.DeleteCourseModuleRequest{Id: makeDisposableModule(t)}); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
	})
}

// ── LessonService ─────────────────────────────────────────────────────────────

func TestLessonValidation(t *testing.T) {
	c := setupCoursesTestClients(t)
	ctx := t.Context()
	_, _, ownerID := createActiveUser(t, c.users)
	orgID := createTestOrgForCourses(t, c, ownerID)
	courseID := createTestCourse(t, c, orgID, ownerID)
	moduleID := createTestModule(t, c, courseID, 0)

	tests := []struct {
		name string
		req  *richterv1.CreateLessonRequest
	}{
		{
			name: "InvalidModuleUUID",
			req:  &richterv1.CreateLessonRequest{ModuleId: "not-a-uuid", Title: "X", OrderIndex: 0},
		},
		{
			name: "EmptyTitle",
			req:  &richterv1.CreateLessonRequest{ModuleId: moduleID, Title: "", OrderIndex: 0},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := c.lessons.CreateLesson(ctx, tt.req)
			assertCode(t, err, connect.CodeInvalidArgument)
		})
	}
}

func TestLessonLifecycle(t *testing.T) {
	c := setupCoursesTestClients(t)
	ctx := t.Context()
	_, _, ownerID := createActiveUser(t, c.users)
	orgID := createTestOrgForCourses(t, c, ownerID)
	courseID := createTestCourse(t, c, orgID, ownerID)
	moduleID := createTestModule(t, c, courseID, 0)

	title := gofakeit.JobTitle()
	description := gofakeit.Sentence(6)
	var lessonID string

	t.Run("CreateLesson", func(t *testing.T) {
		res, err := c.lessons.CreateLesson(ctx, &richterv1.CreateLessonRequest{
			ModuleId:    moduleID,
			Title:       title,
			Description: description,
			OrderIndex:  0,
		})
		if err != nil {
			t.Fatalf("create lesson: %v", err)
		}
		if res.Lesson.Title != title {
			t.Errorf("expected title %q, got %q", title, res.Lesson.Title)
		}
		if res.Lesson.Description != description {
			t.Errorf("expected description %q, got %q", description, res.Lesson.Description)
		}
		if res.Lesson.ModuleId != moduleID {
			t.Errorf("expected module_id %s, got %s", moduleID, res.Lesson.ModuleId)
		}
		lessonID = res.Lesson.Id
	})

	t.Run("GetLessonById", func(t *testing.T) {
		res, err := c.lessons.GetLessonById(ctx, &richterv1.GetLessonByIdRequest{Id: lessonID})
		if err != nil {
			t.Fatalf("get lesson: %v", err)
		}
		if res.Lesson.Id != lessonID {
			t.Errorf("expected id %s, got %s", lessonID, res.Lesson.Id)
		}
	})

	t.Run("ListLessons", func(t *testing.T) {
		res, err := c.lessons.ListLessons(ctx, &richterv1.ListLessonsRequest{ModuleId: moduleID, Limit: 50})
		if err != nil {
			t.Fatalf("list lessons: %v", err)
		}
		found := false
		for _, l := range res.Lessons {
			if l.Id == lessonID {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("lesson %s not found in list", lessonID)
		}
	})

	t.Run("ListLessonsByCourse", func(t *testing.T) {
		res, err := c.lessons.ListLessonsByCourse(ctx, &richterv1.ListLessonsByCourseRequest{CourseId: courseID, Limit: 50})
		if err != nil {
			t.Fatalf("list lessons by course: %v", err)
		}
		found := false
		for _, l := range res.Lessons {
			if l.Id == lessonID {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("lesson %s not found in ListLessonsByCourse", lessonID)
		}
	})

	t.Run("UpdateLesson", func(t *testing.T) {
		newTitle := gofakeit.JobTitle()
		res, err := c.lessons.UpdateLesson(ctx, &richterv1.UpdateLessonRequest{
			Id:         lessonID,
			Title:      newTitle,
			OrderIndex: 1,
		})
		if err != nil {
			t.Fatalf("update lesson: %v", err)
		}
		if res.Lesson.Title != newTitle {
			t.Errorf("expected title %q, got %q", newTitle, res.Lesson.Title)
		}
		if res.Lesson.OrderIndex != 1 {
			t.Errorf("expected order_index 1, got %d", res.Lesson.OrderIndex)
		}
	})

	t.Run("UpdateLessonVideo", func(t *testing.T) {
		key := "lessons/" + lessonID + "/video.mp4"
		res, err := c.lessons.UpdateLessonVideo(ctx, &richterv1.UpdateLessonVideoRequest{
			Id:              lessonID,
			VideoStorageKey: key,
			DurationSeconds: 120,
		})
		if err != nil {
			t.Fatalf("update lesson video: %v", err)
		}
		if res.Lesson.VideoStorageKey != key {
			t.Errorf("expected video_storage_key %q, got %q", key, res.Lesson.VideoStorageKey)
		}
		if res.Lesson.DurationSeconds != 120 {
			t.Errorf("expected duration_seconds 120, got %d", res.Lesson.DurationSeconds)
		}
	})

	t.Run("GetLesson_HasVideoFields", func(t *testing.T) {
		res, err := c.lessons.GetLessonById(ctx, &richterv1.GetLessonByIdRequest{Id: lessonID})
		if err != nil {
			t.Fatalf("get lesson: %v", err)
		}
		if res.Lesson.VideoStorageKey == "" {
			t.Error("expected video_storage_key to be set after UpdateLessonVideo")
		}
		if res.Lesson.DurationSeconds != 120 {
			t.Errorf("expected duration_seconds 120, got %d", res.Lesson.DurationSeconds)
		}
	})

	t.Run("DeleteLesson", func(t *testing.T) {
		_, err := c.lessons.DeleteLesson(ctx, &richterv1.DeleteLessonRequest{Id: lessonID})
		if err != nil {
			t.Fatalf("delete lesson: %v", err)
		}
	})

	t.Run("VerifyDeleted", func(t *testing.T) {
		_, err := c.lessons.GetLessonById(ctx, &richterv1.GetLessonByIdRequest{Id: lessonID})
		assertCode(t, err, connect.CodeNotFound)
	})
}

func TestLessonErrors(t *testing.T) {
	c := setupCoursesTestClients(t)
	ctx := t.Context()

	t.Run("GetNotFound", func(t *testing.T) {
		_, err := c.lessons.GetLessonById(ctx, &richterv1.GetLessonByIdRequest{Id: gofakeit.UUID()})
		assertCode(t, err, connect.CodeNotFound)
	})

	t.Run("UpdateNotFound", func(t *testing.T) {
		_, err := c.lessons.UpdateLesson(ctx, &richterv1.UpdateLessonRequest{
			Id: gofakeit.UUID(), Title: "X", OrderIndex: 0,
		})
		assertCode(t, err, connect.CodeNotFound)
	})

	t.Run("DeleteNotFound", func(t *testing.T) {
		_, err := c.lessons.DeleteLesson(ctx, &richterv1.DeleteLessonRequest{Id: gofakeit.UUID()})
		assertCode(t, err, connect.CodeNotFound)
	})
}

func TestLessonsAuthz(t *testing.T) {
	url := newV1Server(t)
	ctx := context.Background()
	adminToken := getAdminToken(t, url)

	adminUsers := richterv1connect.NewUserServiceClient(httpClientWithToken(adminToken), url)
	adminMembers := richterv1connect.NewOrganizationMemberServiceClient(httpClientWithToken(adminToken), url)
	adminCourses := richterv1connect.NewCourseServiceClient(httpClientWithToken(adminToken), url)
	adminModules := richterv1connect.NewCourseModuleServiceClient(httpClientWithToken(adminToken), url)
	adminLessons := richterv1connect.NewLessonServiceClient(httpClientWithToken(adminToken), url)
	anonLessons := richterv1connect.NewLessonServiceClient(http.DefaultClient, url)

	ownerEmail, ownerPass, ownerID := createActiveUser(t, adminUsers)
	ownerToken := getUserToken(t, url, ownerEmail, ownerPass)

	teacherEmail, teacherPass, teacherID := createActiveUser(t, adminUsers)
	teacherToken := getUserToken(t, url, teacherEmail, teacherPass)

	studentEmail, studentPass, studentID := createActiveUser(t, adminUsers)
	studentToken := getUserToken(t, url, studentEmail, studentPass)

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
	courseID := courseRes.Course.Id

	moduleRes, err := adminModules.CreateCourseModule(ctx, &richterv1.CreateCourseModuleRequest{
		CourseId: courseID, Title: gofakeit.JobTitle(), OrderIndex: 0,
	})
	if err != nil {
		t.Fatalf("setup: create module: %v", err)
	}
	moduleID := moduleRes.Module.Id
	lessonID := createTestLesson(t,
		coursesTestClients{lessons: adminLessons},
		moduleID, 0)

	ownerLessons := richterv1connect.NewLessonServiceClient(httpClientWithToken(ownerToken), url)
	teacherLessons := richterv1connect.NewLessonServiceClient(httpClientWithToken(teacherToken), url)
	studentLessons := richterv1connect.NewLessonServiceClient(httpClientWithToken(studentToken), url)
	nonMemberLessons := richterv1connect.NewLessonServiceClient(httpClientWithToken(nonMemberToken), url)

	// --- CreateLesson ---
	t.Run("CreateLesson", func(t *testing.T) {
		req := func() *richterv1.CreateLessonRequest {
			return &richterv1.CreateLessonRequest{ModuleId: moduleID, Title: gofakeit.JobTitle(), OrderIndex: 99}
		}
		t.Run("Anon/Unauthenticated", func(t *testing.T) {
			assertCode(t, func() error { _, e := anonLessons.CreateLesson(ctx, req()); return e }(), connect.CodeUnauthenticated)
		})
		t.Run("NonMember/PermissionDenied", func(t *testing.T) {
			assertCode(t, func() error { _, e := nonMemberLessons.CreateLesson(ctx, req()); return e }(), connect.CodePermissionDenied)
		})
		t.Run("Student/PermissionDenied", func(t *testing.T) {
			assertCode(t, func() error { _, e := studentLessons.CreateLesson(ctx, req()); return e }(), connect.CodePermissionDenied)
		})
		t.Run("Teacher/OK", func(t *testing.T) {
			if _, err := teacherLessons.CreateLesson(ctx, req()); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
		t.Run("Owner/OK", func(t *testing.T) {
			if _, err := ownerLessons.CreateLesson(ctx, req()); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
	})

	// --- GetLessonById ---
	t.Run("GetLessonById", func(t *testing.T) {
		req := &richterv1.GetLessonByIdRequest{Id: lessonID}
		t.Run("Anon/Unauthenticated", func(t *testing.T) {
			assertCode(t, func() error { _, e := anonLessons.GetLessonById(ctx, req); return e }(), connect.CodeUnauthenticated)
		})
		t.Run("Student/OK", func(t *testing.T) {
			if _, err := studentLessons.GetLessonById(ctx, req); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
		t.Run("NonMember/OK", func(t *testing.T) {
			if _, err := nonMemberLessons.GetLessonById(ctx, req); err != nil {
				t.Errorf("expected OK for any authenticated user, got %v", err)
			}
		})
	})

	// --- ListLessons ---
	t.Run("ListLessons", func(t *testing.T) {
		req := &richterv1.ListLessonsRequest{ModuleId: moduleID, Limit: 50}
		t.Run("Anon/Unauthenticated", func(t *testing.T) {
			assertCode(t, func() error { _, e := anonLessons.ListLessons(ctx, req); return e }(), connect.CodeUnauthenticated)
		})
		t.Run("NonMember/OK", func(t *testing.T) {
			if _, err := nonMemberLessons.ListLessons(ctx, req); err != nil {
				t.Errorf("expected OK for any authenticated user, got %v", err)
			}
		})
	})

	// --- ListLessonsByCourse ---
	t.Run("ListLessonsByCourse", func(t *testing.T) {
		req := &richterv1.ListLessonsByCourseRequest{CourseId: courseID, Limit: 50}
		t.Run("Anon/Unauthenticated", func(t *testing.T) {
			assertCode(t, func() error { _, e := anonLessons.ListLessonsByCourse(ctx, req); return e }(), connect.CodeUnauthenticated)
		})
		t.Run("NonMember/OK", func(t *testing.T) {
			if _, err := nonMemberLessons.ListLessonsByCourse(ctx, req); err != nil {
				t.Errorf("expected OK for any authenticated user, got %v", err)
			}
		})
	})

	// --- UpdateLesson ---
	t.Run("UpdateLesson", func(t *testing.T) {
		req := &richterv1.UpdateLessonRequest{Id: lessonID, Title: gofakeit.JobTitle(), OrderIndex: 0}
		t.Run("Anon/Unauthenticated", func(t *testing.T) {
			assertCode(t, func() error { _, e := anonLessons.UpdateLesson(ctx, req); return e }(), connect.CodeUnauthenticated)
		})
		t.Run("NonMember/PermissionDenied", func(t *testing.T) {
			assertCode(t, func() error { _, e := nonMemberLessons.UpdateLesson(ctx, req); return e }(), connect.CodePermissionDenied)
		})
		t.Run("Student/PermissionDenied", func(t *testing.T) {
			assertCode(t, func() error { _, e := studentLessons.UpdateLesson(ctx, req); return e }(), connect.CodePermissionDenied)
		})
		t.Run("Teacher/OK", func(t *testing.T) {
			if _, err := teacherLessons.UpdateLesson(ctx, req); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
	})

	// --- UpdateLessonVideo ---
	t.Run("UpdateLessonVideo", func(t *testing.T) {
		req := &richterv1.UpdateLessonVideoRequest{
			Id:              lessonID,
			VideoStorageKey: "lessons/" + lessonID + "/video.mp4",
			DurationSeconds: 60,
		}
		t.Run("Anon/Unauthenticated", func(t *testing.T) {
			assertCode(t, func() error { _, e := anonLessons.UpdateLessonVideo(ctx, req); return e }(), connect.CodeUnauthenticated)
		})
		t.Run("NonMember/PermissionDenied", func(t *testing.T) {
			assertCode(t, func() error { _, e := nonMemberLessons.UpdateLessonVideo(ctx, req); return e }(), connect.CodePermissionDenied)
		})
		t.Run("Student/PermissionDenied", func(t *testing.T) {
			assertCode(t, func() error { _, e := studentLessons.UpdateLessonVideo(ctx, req); return e }(), connect.CodePermissionDenied)
		})
		t.Run("Teacher/OK", func(t *testing.T) {
			if _, err := teacherLessons.UpdateLessonVideo(ctx, req); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
	})

	// --- DeleteLesson ---
	t.Run("DeleteLesson", func(t *testing.T) {
		makeDisposableLesson := func(t *testing.T) string {
			t.Helper()
			res, err := adminLessons.CreateLesson(ctx, &richterv1.CreateLessonRequest{
				ModuleId: moduleID, Title: gofakeit.JobTitle(), OrderIndex: 99,
			})
			if err != nil {
				t.Fatalf("setup: create disposable lesson: %v", err)
			}
			return res.Lesson.Id
		}
		t.Run("Anon/Unauthenticated", func(t *testing.T) {
			assertCode(t, func() error {
				_, e := anonLessons.DeleteLesson(ctx, &richterv1.DeleteLessonRequest{Id: makeDisposableLesson(t)})
				return e
			}(), connect.CodeUnauthenticated)
		})
		t.Run("NonMember/PermissionDenied", func(t *testing.T) {
			assertCode(t, func() error {
				_, e := nonMemberLessons.DeleteLesson(ctx, &richterv1.DeleteLessonRequest{Id: makeDisposableLesson(t)})
				return e
			}(), connect.CodePermissionDenied)
		})
		t.Run("Student/PermissionDenied", func(t *testing.T) {
			assertCode(t, func() error {
				_, e := studentLessons.DeleteLesson(ctx, &richterv1.DeleteLessonRequest{Id: makeDisposableLesson(t)})
				return e
			}(), connect.CodePermissionDenied)
		})
		t.Run("Teacher/OK", func(t *testing.T) {
			if _, err := teacherLessons.DeleteLesson(ctx, &richterv1.DeleteLessonRequest{Id: makeDisposableLesson(t)}); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
		t.Run("Owner/OK", func(t *testing.T) {
			if _, err := ownerLessons.DeleteLesson(ctx, &richterv1.DeleteLessonRequest{Id: makeDisposableLesson(t)}); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
	})
}
