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

// ── test client bundle ────────────────────────────────────────────────────────

type courseMembersTestClients struct {
	courseMembers richterv1connect.CourseMemberServiceClient
	courses       richterv1connect.CourseServiceClient
	modules       richterv1connect.CourseModuleServiceClient
	lessons       richterv1connect.LessonServiceClient
	orgs          richterv1connect.OrganizationServiceClient
	orgMembers    richterv1connect.OrganizationMemberServiceClient
	users         richterv1connect.UserServiceClient
}

func setupCourseMembersTestClients(t *testing.T) (courseMembersTestClients, string) {
	t.Helper()
	url := newV1Server(t)
	adminToken := getAdminToken(t, url)
	return courseMembersTestClients{
		courseMembers: richterv1connect.NewCourseMemberServiceClient(httpClientWithToken(adminToken), url),
		courses:       richterv1connect.NewCourseServiceClient(httpClientWithToken(adminToken), url),
		modules:       richterv1connect.NewCourseModuleServiceClient(httpClientWithToken(adminToken), url),
		lessons:       richterv1connect.NewLessonServiceClient(httpClientWithToken(adminToken), url),
		orgs:          richterv1connect.NewOrganizationServiceClient(httpClientWithToken(adminToken), url),
		orgMembers:    richterv1connect.NewOrganizationMemberServiceClient(httpClientWithToken(adminToken), url),
		users:         richterv1connect.NewUserServiceClient(httpClientWithToken(adminToken), url),
	}, url
}

// ── setup helpers ─────────────────────────────────────────────────────────────

func createCMTestOrg(t *testing.T, c courseMembersTestClients, ownerID string) string {
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

func addOrgMember(t *testing.T, c courseMembersTestClients, orgID, userID string, role richterv1.OrganizationRole) {
	t.Helper()
	_, err := c.orgMembers.AddOrganizationMember(context.Background(), &richterv1.AddOrganizationMemberRequest{
		OrganizationId: orgID,
		UserId:         userID,
		Role:           role,
		Status:         richterv1.MemberStatus_MEMBER_STATUS_ACTIVE,
	})
	if err != nil {
		t.Fatalf("setup: add org member: %v", err)
	}
}

func createCMTestCourse(t *testing.T, c courseMembersTestClients, orgID, ownerID string) string {
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

func createCMTestModule(t *testing.T, c courseMembersTestClients, courseID string) string {
	t.Helper()
	res, err := c.modules.CreateCourseModule(context.Background(), &richterv1.CreateCourseModuleRequest{
		CourseId:   courseID,
		Title:      gofakeit.JobTitle(),
		OrderIndex: 0,
	})
	if err != nil {
		t.Fatalf("setup: create module: %v", err)
	}
	return res.Module.Id
}

func createCMTestLesson(t *testing.T, c courseMembersTestClients, moduleID string) string {
	t.Helper()
	res, err := c.lessons.CreateLesson(context.Background(), &richterv1.CreateLessonRequest{
		ModuleId:   moduleID,
		Title:      gofakeit.JobTitle(),
		OrderIndex: 0,
	})
	if err != nil {
		t.Fatalf("setup: create lesson: %v", err)
	}
	return res.Lesson.Id
}

// ── validation tests ──────────────────────────────────────────────────────────

func TestCourseMemberValidation(t *testing.T) {
	c, _ := setupCourseMembersTestClients(t)
	ctx := t.Context()
	_, _, ownerID := createActiveUser(t, c.users)
	orgID := createCMTestOrg(t, c, ownerID)
	courseID := createCMTestCourse(t, c, orgID, ownerID)

	t.Run("AddCourseMember_InvalidCourseUUID", func(t *testing.T) {
		_, err := c.courseMembers.AddCourseMember(ctx, &richterv1.AddCourseMemberRequest{
			CourseId: "not-a-uuid",
			UserId:   ownerID,
			Role:     richterv1.CourseRole_COURSE_ROLE_STUDENT,
		})
		assertCode(t, err, connect.CodeInvalidArgument)
	})

	t.Run("AddCourseMember_InvalidUserUUID", func(t *testing.T) {
		_, err := c.courseMembers.AddCourseMember(ctx, &richterv1.AddCourseMemberRequest{
			CourseId: courseID,
			UserId:   "not-a-uuid",
			Role:     richterv1.CourseRole_COURSE_ROLE_STUDENT,
		})
		assertCode(t, err, connect.CodeInvalidArgument)
	})

	t.Run("AddCourseMember_UnspecifiedRole", func(t *testing.T) {
		_, err := c.courseMembers.AddCourseMember(ctx, &richterv1.AddCourseMemberRequest{
			CourseId: courseID,
			UserId:   ownerID,
			Role:     richterv1.CourseRole_COURSE_ROLE_UNSPECIFIED,
		})
		assertCode(t, err, connect.CodeInvalidArgument)
	})

	t.Run("ListCourseMembers_LimitTooLarge", func(t *testing.T) {
		_, err := c.courseMembers.ListCourseMembers(ctx, &richterv1.ListCourseMembersRequest{
			CourseId: courseID,
			Limit:    200,
			Offset:   0,
		})
		assertCode(t, err, connect.CodeInvalidArgument)
	})

	t.Run("ListCourseMembers_LimitZero", func(t *testing.T) {
		_, err := c.courseMembers.ListCourseMembers(ctx, &richterv1.ListCourseMembersRequest{
			CourseId: courseID,
			Limit:    0,
			Offset:   0,
		})
		assertCode(t, err, connect.CodeInvalidArgument)
	})
}

// ── lifecycle tests ───────────────────────────────────────────────────────────

func TestCourseMemberLifecycle(t *testing.T) {
	c, _ := setupCourseMembersTestClients(t)
	ctx := t.Context()

	_, _, ownerID := createActiveUser(t, c.users)
	_, _, memberID := createActiveUser(t, c.users)
	orgID := createCMTestOrg(t, c, ownerID)
	courseID := createCMTestCourse(t, c, orgID, ownerID)

	// Add owner to org so the course owner-check queries work.
	addOrgMember(t, c, orgID, ownerID, richterv1.OrganizationRole_ORGANIZATION_ROLE_OWNER)
	// Add the test member to org (student role) so they can later be added to the course.
	addOrgMember(t, c, orgID, memberID, richterv1.OrganizationRole_ORGANIZATION_ROLE_STUDENT)

	t.Run("AddCourseMember", func(t *testing.T) {
		res, err := c.courseMembers.AddCourseMember(ctx, &richterv1.AddCourseMemberRequest{
			CourseId: courseID,
			UserId:   memberID,
			Role:     richterv1.CourseRole_COURSE_ROLE_STUDENT,
		})
		if err != nil {
			t.Fatalf("add course member: %v", err)
		}
		if res.Member.UserId != memberID {
			t.Errorf("expected user_id %s, got %s", memberID, res.Member.UserId)
		}
		if res.Member.Role != richterv1.CourseRole_COURSE_ROLE_STUDENT {
			t.Errorf("expected role STUDENT, got %v", res.Member.Role)
		}
	})

	t.Run("AddCourseMember_Upsert", func(t *testing.T) {
		// Adding the same user again with a different role should upsert.
		res, err := c.courseMembers.AddCourseMember(ctx, &richterv1.AddCourseMemberRequest{
			CourseId: courseID,
			UserId:   memberID,
			Role:     richterv1.CourseRole_COURSE_ROLE_TEACHER,
		})
		if err != nil {
			t.Fatalf("upsert course member: %v", err)
		}
		if res.Member.Role != richterv1.CourseRole_COURSE_ROLE_TEACHER {
			t.Errorf("expected role TEACHER after upsert, got %v", res.Member.Role)
		}
		// Reset back to student for subsequent tests.
		_, err = c.courseMembers.AddCourseMember(ctx, &richterv1.AddCourseMemberRequest{
			CourseId: courseID,
			UserId:   memberID,
			Role:     richterv1.CourseRole_COURSE_ROLE_STUDENT,
		})
		if err != nil {
			t.Fatalf("reset course member to student: %v", err)
		}
	})

	t.Run("ListCourseMembers", func(t *testing.T) {
		res, err := c.courseMembers.ListCourseMembers(ctx, &richterv1.ListCourseMembersRequest{
			CourseId: courseID,
			Limit:    10,
			Offset:   0,
		})
		if err != nil {
			t.Fatalf("list course members: %v", err)
		}
		found := false
		for _, m := range res.Members {
			if m.UserId == memberID {
				found = true
				// Verify embedded user fields are populated.
				if m.UserEmail == "" {
					t.Error("expected UserEmail to be populated")
				}
				break
			}
		}
		if !found {
			t.Errorf("member %s not found in list", memberID)
		}
	})

	t.Run("ListCourseMembers_Pagination", func(t *testing.T) {
		res, err := c.courseMembers.ListCourseMembers(ctx, &richterv1.ListCourseMembersRequest{
			CourseId: courseID,
			Limit:    1,
			Offset:   0,
		})
		if err != nil {
			t.Fatalf("list course members page 1: %v", err)
		}
		if len(res.Members) != 1 {
			t.Errorf("expected 1 member (page 1), got %d", len(res.Members))
		}

		res2, err := c.courseMembers.ListCourseMembers(ctx, &richterv1.ListCourseMembersRequest{
			CourseId: courseID,
			Limit:    1,
			Offset:   1,
		})
		if err != nil {
			t.Fatalf("list course members page 2: %v", err)
		}
		if len(res2.Members) != 0 {
			t.Errorf("expected 0 members (past end), got %d", len(res2.Members))
		}
	})

	t.Run("RemoveCourseMember", func(t *testing.T) {
		_, err := c.courseMembers.RemoveCourseMember(ctx, &richterv1.RemoveCourseMemberRequest{
			CourseId: courseID,
			UserId:   memberID,
		})
		if err != nil {
			t.Fatalf("remove course member: %v", err)
		}
		// List should now be empty.
		res, err := c.courseMembers.ListCourseMembers(ctx, &richterv1.ListCourseMembersRequest{
			CourseId: courseID,
			Limit:    10,
			Offset:   0,
		})
		if err != nil {
			t.Fatalf("list after remove: %v", err)
		}
		for _, m := range res.Members {
			if m.UserId == memberID {
				t.Error("member still present after RemoveCourseMember")
			}
		}
	})

	t.Run("RemoveCourseMember_NotFound", func(t *testing.T) {
		_, err := c.courseMembers.RemoveCourseMember(ctx, &richterv1.RemoveCourseMemberRequest{
			CourseId: courseID,
			UserId:   memberID,
		})
		assertCode(t, err, connect.CodeNotFound)
	})
}

// ── access gate tests ─────────────────────────────────────────────────────────

// TestCourseMemberAccessGate verifies that:
//   - An org member who is NOT a course member is denied access to GetLessonById and GetCourseById.
//   - An org member who IS a course member may access those endpoints.
//   - An org admin (not an explicit course member) may access those endpoints.
//   - The course owner may access those endpoints.
func TestCourseMemberAccessGate(t *testing.T) {
	c, url := setupCourseMembersTestClients(t)
	ctx := t.Context()

	// Create participants.
	ownerEmail, ownerPass, ownerID := createActiveUser(t, c.users)
	memberEmail, memberPass, memberID := createActiveUser(t, c.users)
	nonMemberEmail, nonMemberPass, nonMemberID := createActiveUser(t, c.users)
	adminEmail, adminPass, adminID := createActiveUser(t, c.users)
	_ = nonMemberID

	// Set up org.
	orgID := createCMTestOrg(t, c, ownerID)
	addOrgMember(t, c, orgID, ownerID, richterv1.OrganizationRole_ORGANIZATION_ROLE_OWNER)
	addOrgMember(t, c, orgID, memberID, richterv1.OrganizationRole_ORGANIZATION_ROLE_STUDENT)
	addOrgMember(t, c, orgID, nonMemberID, richterv1.OrganizationRole_ORGANIZATION_ROLE_STUDENT)
	addOrgMember(t, c, orgID, adminID, richterv1.OrganizationRole_ORGANIZATION_ROLE_ADMIN)

	// Set up course and lesson.
	courseID := createCMTestCourse(t, c, orgID, ownerID)
	moduleID := createCMTestModule(t, c, courseID)
	lessonID := createCMTestLesson(t, c, moduleID)

	// Add memberID as explicit course member.
	_, err := c.courseMembers.AddCourseMember(ctx, &richterv1.AddCourseMemberRequest{
		CourseId: courseID,
		UserId:   memberID,
		Role:     richterv1.CourseRole_COURSE_ROLE_STUDENT,
	})
	if err != nil {
		t.Fatalf("setup: add course member: %v", err)
	}

	// Tokens for each actor.
	ownerToken := getUserToken(t, url, ownerEmail, ownerPass)
	memberToken := getUserToken(t, url, memberEmail, memberPass)
	nonMemberToken := getUserToken(t, url, nonMemberEmail, nonMemberPass)
	adminToken := getUserToken(t, url, adminEmail, adminPass)

	lessons := func(tok string) richterv1connect.LessonServiceClient {
		return richterv1connect.NewLessonServiceClient(httpClientWithToken(tok), url)
	}
	courses := func(tok string) richterv1connect.CourseServiceClient {
		return richterv1connect.NewCourseServiceClient(httpClientWithToken(tok), url)
	}

	t.Run("NonMember_GetLessonById_Denied", func(t *testing.T) {
		_, err := lessons(nonMemberToken).GetLessonById(ctx, &richterv1.GetLessonByIdRequest{Id: lessonID})
		assertCode(t, err, connect.CodePermissionDenied)
	})

	t.Run("NonMember_GetCourseById_Denied", func(t *testing.T) {
		_, err := courses(nonMemberToken).GetCourseById(ctx, &richterv1.GetCourseByIdRequest{Id: courseID})
		assertCode(t, err, connect.CodePermissionDenied)
	})

	t.Run("CourseMember_GetLessonById_Allowed", func(t *testing.T) {
		_, err := lessons(memberToken).GetLessonById(ctx, &richterv1.GetLessonByIdRequest{Id: lessonID})
		if err != nil {
			t.Errorf("course member should be allowed to GetLessonById, got %v", err)
		}
	})

	t.Run("CourseMember_GetCourseById_Allowed", func(t *testing.T) {
		_, err := courses(memberToken).GetCourseById(ctx, &richterv1.GetCourseByIdRequest{Id: courseID})
		if err != nil {
			t.Errorf("course member should be allowed to GetCourseById, got %v", err)
		}
	})

	t.Run("OrgAdmin_GetLessonById_Allowed", func(t *testing.T) {
		_, err := lessons(adminToken).GetLessonById(ctx, &richterv1.GetLessonByIdRequest{Id: lessonID})
		if err != nil {
			t.Errorf("org admin should bypass course membership check for GetLessonById, got %v", err)
		}
	})

	t.Run("OrgAdmin_GetCourseById_Allowed", func(t *testing.T) {
		_, err := courses(adminToken).GetCourseById(ctx, &richterv1.GetCourseByIdRequest{Id: courseID})
		if err != nil {
			t.Errorf("org admin should bypass course membership check for GetCourseById, got %v", err)
		}
	})

	t.Run("CourseOwner_GetLessonById_Allowed", func(t *testing.T) {
		_, err := lessons(ownerToken).GetLessonById(ctx, &richterv1.GetLessonByIdRequest{Id: lessonID})
		if err != nil {
			t.Errorf("course owner should bypass course membership check for GetLessonById, got %v", err)
		}
	})

	t.Run("CourseOwner_GetCourseById_Allowed", func(t *testing.T) {
		_, err := courses(ownerToken).GetCourseById(ctx, &richterv1.GetCourseByIdRequest{Id: courseID})
		if err != nil {
			t.Errorf("course owner should bypass course membership check for GetCourseById, got %v", err)
		}
	})

	t.Run("Unauthenticated_GetLessonById_Denied", func(t *testing.T) {
		anonLessons := richterv1connect.NewLessonServiceClient(http.DefaultClient, url)
		_, err := anonLessons.GetLessonById(ctx, &richterv1.GetLessonByIdRequest{Id: lessonID})
		assertCode(t, err, connect.CodeUnauthenticated)
	})
}

// TestListCoursesCanAccess verifies that ListCourses populates the can_access flag
// correctly: course members (and bypasses) get true, non-members get false.
func TestListCoursesCanAccess(t *testing.T) {
	c, url := setupCourseMembersTestClients(t)
	ctx := t.Context()

	// Create all users with recoverable credentials.
	ownerEmail, ownerPass, ownerID := createActiveUser(t, c.users)
	memberEmail, memberPass, memberID := createActiveUser(t, c.users)
	// orgStudentEmail/orgStudentPass is an org-member-only user (no course membership).
	orgStudentEmail, orgStudentPass, orgStudentID := createActiveUser(t, c.users)
	// outOfOrgEmail is not in the org at all.
	outOfOrgEmail, outOfOrgPass, _ := createActiveUser(t, c.users)

	orgID := createCMTestOrg(t, c, ownerID)
	addOrgMember(t, c, orgID, ownerID, richterv1.OrganizationRole_ORGANIZATION_ROLE_OWNER)
	addOrgMember(t, c, orgID, memberID, richterv1.OrganizationRole_ORGANIZATION_ROLE_STUDENT)
	addOrgMember(t, c, orgID, orgStudentID, richterv1.OrganizationRole_ORGANIZATION_ROLE_STUDENT)

	courseID := createCMTestCourse(t, c, orgID, ownerID)

	// Add memberID as explicit course member only.
	_, err := c.courseMembers.AddCourseMember(ctx, &richterv1.AddCourseMemberRequest{
		CourseId: courseID,
		UserId:   memberID,
		Role:     richterv1.CourseRole_COURSE_ROLE_STUDENT,
	})
	if err != nil {
		t.Fatalf("setup: add course member: %v", err)
	}

	ownerToken := getUserToken(t, url, ownerEmail, ownerPass)
	memberToken := getUserToken(t, url, memberEmail, memberPass)
	orgStudentToken := getUserToken(t, url, orgStudentEmail, orgStudentPass)
	outOfOrgToken := getUserToken(t, url, outOfOrgEmail, outOfOrgPass)

	listCourses := func(tok string) ([]*richterv1.Course, error) {
		t.Helper()
		cl := richterv1connect.NewCourseServiceClient(httpClientWithToken(tok), url)
		res, err := cl.ListCourses(ctx, &richterv1.ListCoursesRequest{
			OrganizationId: orgID,
			Limit:          10,
			Offset:         0,
		})
		if err != nil {
			return nil, err
		}
		return res.Courses, nil
	}

	findCourse := func(courses []*richterv1.Course) *richterv1.Course {
		for _, co := range courses {
			if co.Id == courseID {
				return co
			}
		}
		return nil
	}

	t.Run("Owner_CanAccess_True", func(t *testing.T) {
		courses, err := listCourses(ownerToken)
		if err != nil {
			t.Fatalf("list courses as owner: %v", err)
		}
		found := findCourse(courses)
		if found == nil {
			t.Fatal("course not found in owner's list")
		}
		if !found.CanAccess {
			t.Error("owner should have can_access=true")
		}
	})

	t.Run("CourseMember_CanAccess_True", func(t *testing.T) {
		courses, err := listCourses(memberToken)
		if err != nil {
			t.Fatalf("list courses as course member: %v", err)
		}
		found := findCourse(courses)
		if found == nil {
			t.Fatal("course not found in member's list")
		}
		if !found.CanAccess {
			t.Error("course member should have can_access=true")
		}
	})

	t.Run("OrgStudentNonCourseMember_CanAccess_False", func(t *testing.T) {
		// orgStudentID is in the org but NOT explicitly added to the course.
		courses, err := listCourses(orgStudentToken)
		if err != nil {
			t.Fatalf("list courses as org student: %v", err)
		}
		found := findCourse(courses)
		if found == nil {
			t.Fatal("org member should see the course in the list (metadata visible)")
		}
		if found.CanAccess {
			t.Error("org student without course membership should have can_access=false")
		}
	})

	t.Run("OutOfOrg_ListCourses_Denied", func(t *testing.T) {
		// A user not in the org should get PermissionDenied on ListCourses.
		_, err := listCourses(outOfOrgToken)
		assertCode(t, err, connect.CodePermissionDenied)
	})
}
