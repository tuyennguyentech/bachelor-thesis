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

	// ownerID is already an org member (OWNER) because createCMTestOrg uses them as createdBy.
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
//   - An org member who is NOT a course member is denied content access (GetLessonById).
//     GetCourseById is allowed for org members but reports can_access=false (so they can
//     see course metadata / request to join, but not enter content).
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
	// ownerID is already an org member (OWNER) because createCMTestOrg uses them as createdBy.
	orgID := createCMTestOrg(t, c, ownerID)
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

	t.Run("NonMember_GetCourseById_AllowedWithNoAccess", func(t *testing.T) {
		res, err := courses(nonMemberToken).GetCourseById(ctx, &richterv1.GetCourseByIdRequest{Id: courseID})
		if err != nil {
			t.Fatalf("org member should be allowed to GetCourseById, got %v", err)
		}
		if res.Course.CanAccess {
			t.Errorf("expected CanAccess to be false for non-course member")
		}
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

// TestCourseMemberAuthz tests that Add/Remove/List operations enforce manager-only authz.
// Specifically:
//   - A plain student course-member cannot add/remove other members.
//   - A course teacher-member can add/remove members.
//   - An org admin (not an explicit course member) can add/remove members.
//   - A non-manager (org student who is not a course teacher) gets PermissionDenied.
//   - AddCourseMember to a non-existent course returns NotFound (manager sees it).
//   - ListCourseMembers is denied to a non-course-member.
func TestCourseMemberAuthz(t *testing.T) {
	c, url := setupCourseMembersTestClients(t)
	ctx := t.Context()

	// Create all users.
	ownerEmail, ownerPass, ownerID := createActiveUser(t, c.users)
	teacherEmail, teacherPass, teacherID := createActiveUser(t, c.users)
	studentEmail, studentPass, studentID := createActiveUser(t, c.users)
	orgStudentEmail, orgStudentPass, orgStudentID := createActiveUser(t, c.users) // org-only, no course membership
	orgAdminEmail, orgAdminPass, orgAdminID := createActiveUser(t, c.users)
	targetEmail, _, targetID := createActiveUser(t, c.users) // user to be added/removed in authz tests
	_ = targetEmail

	// Set up org.  ownerID is already OWNER via createCMTestOrg.
	orgID := createCMTestOrg(t, c, ownerID)
	addOrgMember(t, c, orgID, teacherID, richterv1.OrganizationRole_ORGANIZATION_ROLE_TEACHER)
	addOrgMember(t, c, orgID, studentID, richterv1.OrganizationRole_ORGANIZATION_ROLE_STUDENT)
	addOrgMember(t, c, orgID, orgStudentID, richterv1.OrganizationRole_ORGANIZATION_ROLE_STUDENT)
	addOrgMember(t, c, orgID, orgAdminID, richterv1.OrganizationRole_ORGANIZATION_ROLE_ADMIN)
	addOrgMember(t, c, orgID, targetID, richterv1.OrganizationRole_ORGANIZATION_ROLE_STUDENT)

	// Set up course.
	courseID := createCMTestCourse(t, c, orgID, ownerID)

	// Enrol teacher and student as course members.
	_, err := c.courseMembers.AddCourseMember(ctx, &richterv1.AddCourseMemberRequest{
		CourseId: courseID, UserId: teacherID, Role: richterv1.CourseRole_COURSE_ROLE_TEACHER,
	})
	if err != nil {
		t.Fatalf("setup: enrol teacher: %v", err)
	}
	_, err = c.courseMembers.AddCourseMember(ctx, &richterv1.AddCourseMemberRequest{
		CourseId: courseID, UserId: studentID, Role: richterv1.CourseRole_COURSE_ROLE_STUDENT,
	})
	if err != nil {
		t.Fatalf("setup: enrol student: %v", err)
	}

	ownerToken := getUserToken(t, url, ownerEmail, ownerPass)
	teacherToken := getUserToken(t, url, teacherEmail, teacherPass)
	studentToken := getUserToken(t, url, studentEmail, studentPass)
	orgStudentToken := getUserToken(t, url, orgStudentEmail, orgStudentPass)
	orgAdminToken := getUserToken(t, url, orgAdminEmail, orgAdminPass)

	cm := func(tok string) richterv1connect.CourseMemberServiceClient {
		return richterv1connect.NewCourseMemberServiceClient(httpClientWithToken(tok), url)
	}

	addReq := func() *richterv1.AddCourseMemberRequest {
		return &richterv1.AddCourseMemberRequest{
			CourseId: courseID, UserId: targetID, Role: richterv1.CourseRole_COURSE_ROLE_STUDENT,
		}
	}
	removeReq := func() *richterv1.RemoveCourseMemberRequest {
		return &richterv1.RemoveCourseMemberRequest{CourseId: courseID, UserId: targetID}
	}

	// ── AddCourseMember authz ──────────────────────────────────────────────────

	t.Run("AddCourseMember/Student_PermissionDenied", func(t *testing.T) {
		// A course student-member cannot manage membership.
		assertCode(t, func() error { _, e := cm(studentToken).AddCourseMember(ctx, addReq()); return e }(), connect.CodePermissionDenied)
	})

	t.Run("AddCourseMember/OrgStudentNonMember_PermissionDenied", func(t *testing.T) {
		// An org student who is not a course member at all cannot manage.
		assertCode(t, func() error { _, e := cm(orgStudentToken).AddCourseMember(ctx, addReq()); return e }(), connect.CodePermissionDenied)
	})

	t.Run("AddCourseMember/Teacher_OK", func(t *testing.T) {
		// A course teacher-member can add.
		if _, e := cm(teacherToken).AddCourseMember(ctx, addReq()); e != nil {
			t.Errorf("teacher should be allowed to AddCourseMember, got %v", e)
		}
	})

	t.Run("AddCourseMember/OrgAdmin_OK", func(t *testing.T) {
		// An org admin (not explicit course member) can add.
		// Target may already be added by the Teacher test; upsert is OK.
		if _, e := cm(orgAdminToken).AddCourseMember(ctx, &richterv1.AddCourseMemberRequest{
			CourseId: courseID, UserId: targetID, Role: richterv1.CourseRole_COURSE_ROLE_STUDENT,
		}); e != nil {
			t.Errorf("org admin should be allowed to AddCourseMember, got %v", e)
		}
	})

	t.Run("AddCourseMember/CourseOwner_OK", func(t *testing.T) {
		// Course owner can add.
		if _, e := cm(ownerToken).AddCourseMember(ctx, &richterv1.AddCourseMemberRequest{
			CourseId: courseID, UserId: targetID, Role: richterv1.CourseRole_COURSE_ROLE_STUDENT,
		}); e != nil {
			t.Errorf("course owner should be allowed to AddCourseMember, got %v", e)
		}
	})

	t.Run("AddCourseMember_NonExistentCourse_Rejected", func(t *testing.T) {
		// A manager adding a member to a non-existent course is rejected. The
		// course foreign key cannot be satisfied, surfaced as FailedPrecondition.
		_, e := c.courseMembers.AddCourseMember(ctx, &richterv1.AddCourseMemberRequest{
			CourseId: gofakeit.UUID(), UserId: targetID, Role: richterv1.CourseRole_COURSE_ROLE_STUDENT,
		})
		assertCode(t, e, connect.CodeFailedPrecondition)
	})

	// ── RemoveCourseMember authz ───────────────────────────────────────────────

	// Ensure target is enrolled first so we have someone to remove.
	_, err = c.courseMembers.AddCourseMember(ctx, &richterv1.AddCourseMemberRequest{
		CourseId: courseID, UserId: targetID, Role: richterv1.CourseRole_COURSE_ROLE_STUDENT,
	})
	if err != nil {
		t.Fatalf("setup: enrol target for remove tests: %v", err)
	}

	t.Run("RemoveCourseMember/Student_PermissionDenied", func(t *testing.T) {
		assertCode(t, func() error { _, e := cm(studentToken).RemoveCourseMember(ctx, removeReq()); return e }(), connect.CodePermissionDenied)
	})

	t.Run("RemoveCourseMember/OrgStudentNonMember_PermissionDenied", func(t *testing.T) {
		assertCode(t, func() error { _, e := cm(orgStudentToken).RemoveCourseMember(ctx, removeReq()); return e }(), connect.CodePermissionDenied)
	})

	t.Run("RemoveCourseMember/Teacher_OK", func(t *testing.T) {
		// Teacher removes target; subsequent remove by teacher should return NotFound.
		if _, e := cm(teacherToken).RemoveCourseMember(ctx, removeReq()); e != nil {
			t.Errorf("teacher should be allowed to RemoveCourseMember, got %v", e)
		}
	})

	t.Run("RemoveCourseMember/NotMember_NotFound", func(t *testing.T) {
		// Target was just removed; removing again → NotFound (not a no-op).
		_, e := cm(ownerToken).RemoveCourseMember(ctx, removeReq())
		assertCode(t, e, connect.CodeNotFound)
	})

	// ── ListCourseMembers authz ────────────────────────────────────────────────

	t.Run("ListCourseMembers/NonMember_PermissionDenied", func(t *testing.T) {
		// orgStudentID is in the org but not in the course.
		_, e := cm(orgStudentToken).ListCourseMembers(ctx, &richterv1.ListCourseMembersRequest{
			CourseId: courseID, Limit: 10, Offset: 0,
		})
		assertCode(t, e, connect.CodePermissionDenied)
	})

	t.Run("ListCourseMembers/Member_OK", func(t *testing.T) {
		if _, e := cm(studentToken).ListCourseMembers(ctx, &richterv1.ListCourseMembersRequest{
			CourseId: courseID, Limit: 10, Offset: 0,
		}); e != nil {
			t.Errorf("course student-member should be allowed to ListCourseMembers, got %v", e)
		}
	})

	t.Run("ListCourseMembers/DisplayNameAndEmail", func(t *testing.T) {
		// Verify the JOIN populates display name fields on each returned member.
		res, e := c.courseMembers.ListCourseMembers(ctx, &richterv1.ListCourseMembersRequest{
			CourseId: courseID, Limit: 50, Offset: 0,
		})
		if e != nil {
			t.Fatalf("ListCourseMembers: %v", e)
		}
		for _, m := range res.Members {
			if m.UserEmail == "" {
				t.Errorf("user_email empty for member %s", m.UserId)
			}
			if m.UserFirstName == "" {
				t.Errorf("user_first_name empty for member %s", m.UserId)
			}
			if m.UserLastName == "" {
				t.Errorf("user_last_name empty for member %s", m.UserId)
			}
		}
	})
}

// TestListUserCourses verifies that ListUserCourses is self-scoped:
//   - The caller can see their own memberships.
//   - Another user's memberships are not accessible (PermissionDenied).
//   - Pagination (limit/offset) works.
func TestListUserCourses(t *testing.T) {
	c, url := setupCourseMembersTestClients(t)
	ctx := t.Context()

	ownerEmail, ownerPass, ownerID := createActiveUser(t, c.users)
	userAEmail, userAPass, userAID := createActiveUser(t, c.users)
	userBEmail, userBPass, userBID := createActiveUser(t, c.users)

	orgID := createCMTestOrg(t, c, ownerID)
	addOrgMember(t, c, orgID, userAID, richterv1.OrganizationRole_ORGANIZATION_ROLE_STUDENT)
	addOrgMember(t, c, orgID, userBID, richterv1.OrganizationRole_ORGANIZATION_ROLE_STUDENT)

	// Create two courses and enrol userA in both, but NOT userB.
	courseID1 := createCMTestCourse(t, c, orgID, ownerID)
	courseID2 := createCMTestCourse(t, c, orgID, ownerID)

	for _, cid := range []string{courseID1, courseID2} {
		if _, err := c.courseMembers.AddCourseMember(ctx, &richterv1.AddCourseMemberRequest{
			CourseId: cid, UserId: userAID, Role: richterv1.CourseRole_COURSE_ROLE_STUDENT,
		}); err != nil {
			t.Fatalf("setup: enrol userA in %s: %v", cid, err)
		}
	}

	_ = ownerEmail
	_ = userBEmail
	userAToken := getUserToken(t, url, userAEmail, userAPass)
	userBToken := getUserToken(t, url, userBEmail, userBPass)

	cmA := richterv1connect.NewCourseMemberServiceClient(httpClientWithToken(userAToken), url)
	cmB := richterv1connect.NewCourseMemberServiceClient(httpClientWithToken(userBToken), url)

	t.Run("Self_SeesMemberships", func(t *testing.T) {
		res, err := cmA.ListUserCourses(ctx, &richterv1.ListUserCoursesRequest{
			UserId: userAID, Limit: 50, Offset: 0,
		})
		if err != nil {
			t.Fatalf("ListUserCourses self: %v", err)
		}
		seen := map[string]bool{}
		for _, m := range res.Memberships {
			seen[m.CourseId] = true
		}
		if !seen[courseID1] {
			t.Errorf("courseID1 not found in userA's memberships")
		}
		if !seen[courseID2] {
			t.Errorf("courseID2 not found in userA's memberships")
		}
	})

	t.Run("Self_Pagination", func(t *testing.T) {
		res1, err := cmA.ListUserCourses(ctx, &richterv1.ListUserCoursesRequest{
			UserId: userAID, Limit: 1, Offset: 0,
		})
		if err != nil {
			t.Fatalf("ListUserCourses page1: %v", err)
		}
		if len(res1.Memberships) != 1 {
			t.Errorf("page1: expected 1 membership, got %d", len(res1.Memberships))
		}
		res2, err := cmA.ListUserCourses(ctx, &richterv1.ListUserCoursesRequest{
			UserId: userAID, Limit: 1, Offset: 1,
		})
		if err != nil {
			t.Fatalf("ListUserCourses page2: %v", err)
		}
		if len(res2.Memberships) != 1 {
			t.Errorf("page2: expected 1 membership, got %d", len(res2.Memberships))
		}
		// IDs on the two pages must differ.
		if res1.Memberships[0].CourseId == res2.Memberships[0].CourseId {
			t.Errorf("pagination returned the same course on both pages")
		}
	})

	t.Run("Self_NoMemberships_Empty", func(t *testing.T) {
		// userB is not enrolled in any course; must return empty list, not error.
		res, err := cmB.ListUserCourses(ctx, &richterv1.ListUserCoursesRequest{
			UserId: userBID, Limit: 10, Offset: 0,
		})
		if err != nil {
			t.Fatalf("ListUserCourses userB (no memberships): %v", err)
		}
		if len(res.Memberships) != 0 {
			t.Errorf("expected empty list for user with no course memberships, got %d", len(res.Memberships))
		}
	})

	t.Run("OtherUser_PermissionDenied", func(t *testing.T) {
		// userB trying to see userA's memberships.
		_, err := cmB.ListUserCourses(ctx, &richterv1.ListUserCoursesRequest{
			UserId: userAID, Limit: 10, Offset: 0,
		})
		assertCode(t, err, connect.CodePermissionDenied)
	})

	t.Run("Admin_CanSeeOtherUser", func(t *testing.T) {
		// RequireSelf grants sys-admin a bypass (claims.role == ADMIN), so an
		// admin may list another user's course memberships. The self-scope is
		// only enforced against non-admin callers (see NonSelf subtest above).
		if _, err := c.courseMembers.ListUserCourses(ctx, &richterv1.ListUserCoursesRequest{
			UserId: userAID, Limit: 10, Offset: 0,
		}); err != nil {
			t.Errorf("expected admin to list another user's courses, got %v", err)
		}
	})

	// ownerPass is captured but not used for login in this test.
	_ = ownerPass
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

	orgAdminCAEmail, orgAdminCAPass, orgAdminCAID := createActiveUser(t, c.users)

	// ownerID is already an org member (OWNER) because createCMTestOrg uses them as createdBy.
	orgID := createCMTestOrg(t, c, ownerID)
	addOrgMember(t, c, orgID, memberID, richterv1.OrganizationRole_ORGANIZATION_ROLE_STUDENT)
	addOrgMember(t, c, orgID, orgStudentID, richterv1.OrganizationRole_ORGANIZATION_ROLE_STUDENT)
	addOrgMember(t, c, orgID, orgAdminCAID, richterv1.OrganizationRole_ORGANIZATION_ROLE_ADMIN)

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
	orgAdminCAToken := getUserToken(t, url, orgAdminCAEmail, orgAdminCAPass)

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

	t.Run("OrgAdmin_CanAccess_True", func(t *testing.T) {
		// An org admin is not an explicit course member but should bypass the gate.
		courses, err := listCourses(orgAdminCAToken)
		if err != nil {
			t.Fatalf("list courses as org admin: %v", err)
		}
		found := findCourse(courses)
		if found == nil {
			t.Fatal("course not found in org admin's list")
		}
		if !found.CanAccess {
			t.Error("org admin should have can_access=true (bypass)")
		}
	})

	t.Run("OutOfOrg_ListCourses_Denied", func(t *testing.T) {
		// A user not in the org should get PermissionDenied on ListCourses.
		_, err := listCourses(outOfOrgToken)
		assertCode(t, err, connect.CodePermissionDenied)
	})
}

func TestCourseJoinRequests(t *testing.T) {
	c, url := setupCourseMembersTestClients(t)
	ctx := t.Context()

	// Create participants.
	_, _, ownerID := createActiveUser(t, c.users)
	studentEmail, studentPass, studentID := createActiveUser(t, c.users)
	teacherEmail, teacherPass, teacherID := createActiveUser(t, c.users)

	orgID := createCMTestOrg(t, c, ownerID)
	addOrgMember(t, c, orgID, studentID, richterv1.OrganizationRole_ORGANIZATION_ROLE_STUDENT)
	addOrgMember(t, c, orgID, teacherID, richterv1.OrganizationRole_ORGANIZATION_ROLE_TEACHER)

	courseID := createCMTestCourse(t, c, orgID, ownerID)

	// Enroll teacher as a course teacher so they can manage requests
	_, err := c.courseMembers.AddCourseMember(ctx, &richterv1.AddCourseMemberRequest{
		CourseId: courseID,
		UserId:   teacherID,
		Role:     richterv1.CourseRole_COURSE_ROLE_TEACHER,
	})
	if err != nil {
		t.Fatalf("setup: add course teacher: %v", err)
	}

	studentToken := getUserToken(t, url, studentEmail, studentPass)
	teacherToken := getUserToken(t, url, teacherEmail, teacherPass)

	studentCM := richterv1connect.NewCourseMemberServiceClient(httpClientWithToken(studentToken), url)
	teacherCM := richterv1connect.NewCourseMemberServiceClient(httpClientWithToken(teacherToken), url)

	// 1. Get initial status - should be empty/nil (or unspecified)
	statusRes, err := studentCM.GetMyJoinRequestStatus(ctx, &richterv1.GetMyJoinRequestStatusRequest{
		CourseId: courseID,
	})
	if err != nil {
		t.Fatalf("GetMyJoinRequestStatus: %v", err)
	}
	if statusRes.GetRequest() != nil && statusRes.GetRequest().Status != richterv1.JoinRequestStatus_JOIN_REQUEST_STATUS_UNSPECIFIED {
		t.Errorf("expected no request status or unspecified status, got %v", statusRes.GetRequest().Status)
	}

	// 2. Submit join request
	createRes, err := studentCM.CreateJoinRequest(ctx, &richterv1.CreateJoinRequestRequest{
		CourseId: courseID,
	})
	if err != nil {
		t.Fatalf("CreateJoinRequest: %v", err)
	}
	if createRes.GetRequest().Status != richterv1.JoinRequestStatus_JOIN_REQUEST_STATUS_PENDING {
		t.Errorf("expected status PENDING, got %v", createRes.GetRequest().Status)
	}

	// 3. Get status again - should be pending
	statusRes2, err := studentCM.GetMyJoinRequestStatus(ctx, &richterv1.GetMyJoinRequestStatusRequest{
		CourseId: courseID,
	})
	if err != nil {
		t.Fatalf("GetMyJoinRequestStatus: %v", err)
	}
	if statusRes2.GetRequest().GetStatus() != richterv1.JoinRequestStatus_JOIN_REQUEST_STATUS_PENDING {
		t.Errorf("expected status PENDING, got %v", statusRes2.GetRequest().GetStatus())
	}

	// 4. List pending requests as teacher
	listRes, err := teacherCM.ListPendingJoinRequests(ctx, &richterv1.ListPendingJoinRequestsRequest{
		CourseId: courseID,
		Limit:    10,
		Offset:   0,
	})
	if err != nil {
		t.Fatalf("ListPendingJoinRequests: %v", err)
	}
	found := false
	for _, req := range listRes.GetRequests() {
		if req.UserId == studentID {
			found = true
			if req.UserEmail != studentEmail {
				t.Errorf("expected email %s, got %s", studentEmail, req.UserEmail)
			}
		}
	}
	if !found {
		t.Errorf("expected to find student %s in pending requests", studentID)
	}

	// 5. Review and approve request
	_, err = teacherCM.ReviewJoinRequest(ctx, &richterv1.ReviewJoinRequestRequest{
		CourseId: courseID,
		UserId:   studentID,
		Approve:  true,
	})
	if err != nil {
		t.Fatalf("ReviewJoinRequest: %v", err)
	}

	// 6. Verify that the student is now a course member
	coursesClient := richterv1connect.NewCourseServiceClient(httpClientWithToken(studentToken), url)
	getCourseRes, err := coursesClient.GetCourseById(ctx, &richterv1.GetCourseByIdRequest{Id: courseID})
	if err != nil {
		t.Fatalf("GetCourseById: %v", err)
	}
	if !getCourseRes.GetCourse().GetCanAccess() {
		t.Errorf("expected course member to have can_access = true")
	}

	// 7. Test rejection flow for a second student
	student2Email, student2Pass, student2ID := createActiveUser(t, c.users)
	addOrgMember(t, c, orgID, student2ID, richterv1.OrganizationRole_ORGANIZATION_ROLE_STUDENT)
	student2Token := getUserToken(t, url, student2Email, student2Pass)
	student2CM := richterv1connect.NewCourseMemberServiceClient(httpClientWithToken(student2Token), url)

	// Create request for student 2
	_, err = student2CM.CreateJoinRequest(ctx, &richterv1.CreateJoinRequestRequest{
		CourseId: courseID,
	})
	if err != nil {
		t.Fatalf("student2 CreateJoinRequest: %v", err)
	}

	// Reject request
	_, err = teacherCM.ReviewJoinRequest(ctx, &richterv1.ReviewJoinRequestRequest{
		CourseId: courseID,
		UserId:   student2ID,
		Approve:  false,
	})
	if err != nil {
		t.Fatalf("ReviewJoinRequest reject: %v", err)
	}

	// Verify status is rejected
	statusRes3, err := student2CM.GetMyJoinRequestStatus(ctx, &richterv1.GetMyJoinRequestStatusRequest{
		CourseId: courseID,
	})
	if err != nil {
		t.Fatalf("GetMyJoinRequestStatus student2: %v", err)
	}
	if statusRes3.GetRequest().GetStatus() != richterv1.JoinRequestStatus_JOIN_REQUEST_STATUS_REJECTED {
		t.Errorf("expected status REJECTED, got %v", statusRes3.GetRequest().GetStatus())
	}

	// Verify student 2 has no course access
	student2CoursesClient := richterv1connect.NewCourseServiceClient(httpClientWithToken(student2Token), url)
	getCourseRes2, err := student2CoursesClient.GetCourseById(ctx, &richterv1.GetCourseByIdRequest{Id: courseID})
	if err != nil {
		t.Fatalf("GetCourseById student2: %v", err)
	}
	if getCourseRes2.GetCourse().GetCanAccess() {
		t.Error("expected rejected student to have can_access = false")
	}

	// Re-submit request after rejection
	createRes2, err := student2CM.CreateJoinRequest(ctx, &richterv1.CreateJoinRequestRequest{
		CourseId: courseID,
	})
	if err != nil {
		t.Fatalf("student2 Re-CreateJoinRequest: %v", err)
	}
	if createRes2.GetRequest().Status != richterv1.JoinRequestStatus_JOIN_REQUEST_STATUS_PENDING {
		t.Errorf("expected re-request status PENDING, got %v", createRes2.GetRequest().Status)
	}
}

// TestCourseJoinRequestsAuthz verifies authorization and edge-case error codes for
// all four join-request RPCs that were not covered by TestCourseJoinRequests:
//
//   - CreateJoinRequest: non-org-member → PermissionDenied
//   - CreateJoinRequest: already a course member → AlreadyExists
//   - CreateJoinRequest: non-existent course → NotFound
//   - ReviewJoinRequest: caller is a plain student (non-manager) → PermissionDenied
//   - ReviewJoinRequest: no pending request exists for the user → NotFound
//   - ListPendingJoinRequests: caller is a non-manager → PermissionDenied
//   - ListPendingJoinRequests: pagination (limit/offset) works correctly
//   - GetMyJoinRequestStatus: always scoped to the caller's own sub
func TestCourseJoinRequestsAuthz(t *testing.T) {
	c, url := setupCourseMembersTestClients(t)
	ctx := t.Context()

	// Participants
	_, _, ownerID := createActiveUser(t, c.users)
	studentEmail, studentPass, studentID := createActiveUser(t, c.users)
	teacherEmail, teacherPass, teacherID := createActiveUser(t, c.users)
	// outOfOrgEmail is never added to the org.
	outOfOrgEmail, outOfOrgPass, _ := createActiveUser(t, c.users)

	orgID := createCMTestOrg(t, c, ownerID)
	addOrgMember(t, c, orgID, studentID, richterv1.OrganizationRole_ORGANIZATION_ROLE_STUDENT)
	addOrgMember(t, c, orgID, teacherID, richterv1.OrganizationRole_ORGANIZATION_ROLE_TEACHER)

	courseID := createCMTestCourse(t, c, orgID, ownerID)

	// Enrol teacher as course teacher so they can manage requests.
	if _, err := c.courseMembers.AddCourseMember(ctx, &richterv1.AddCourseMemberRequest{
		CourseId: courseID,
		UserId:   teacherID,
		Role:     richterv1.CourseRole_COURSE_ROLE_TEACHER,
	}); err != nil {
		t.Fatalf("setup: enrol teacher: %v", err)
	}

	studentToken := getUserToken(t, url, studentEmail, studentPass)
	teacherToken := getUserToken(t, url, teacherEmail, teacherPass)
	outOfOrgToken := getUserToken(t, url, outOfOrgEmail, outOfOrgPass)

	studentCM := richterv1connect.NewCourseMemberServiceClient(httpClientWithToken(studentToken), url)
	teacherCM := richterv1connect.NewCourseMemberServiceClient(httpClientWithToken(teacherToken), url)
	outOfOrgCM := richterv1connect.NewCourseMemberServiceClient(httpClientWithToken(outOfOrgToken), url)

	// ── CreateJoinRequest edge cases ──────────────────────────────────────────────

	t.Run("CreateJoinRequest/NonOrgMember_PermissionDenied", func(t *testing.T) {
		// A user who is not a member of the course's organization must be denied.
		_, err := outOfOrgCM.CreateJoinRequest(ctx, &richterv1.CreateJoinRequestRequest{
			CourseId: courseID,
		})
		assertCode(t, err, connect.CodePermissionDenied)
	})

	t.Run("CreateJoinRequest/NonExistentCourse_NotFound", func(t *testing.T) {
		// A valid org member requesting to join a non-existent course gets NotFound.
		_, err := studentCM.CreateJoinRequest(ctx, &richterv1.CreateJoinRequestRequest{
			CourseId: gofakeit.UUID(),
		})
		assertCode(t, err, connect.CodeNotFound)
	})

	t.Run("CreateJoinRequest/AlreadyCourseMember_AlreadyExists", func(t *testing.T) {
		// Enrol the student directly as a course member.
		if _, err := c.courseMembers.AddCourseMember(ctx, &richterv1.AddCourseMemberRequest{
			CourseId: courseID,
			UserId:   studentID,
			Role:     richterv1.CourseRole_COURSE_ROLE_STUDENT,
		}); err != nil {
			t.Fatalf("setup: enrol student directly: %v", err)
		}

		_, err := studentCM.CreateJoinRequest(ctx, &richterv1.CreateJoinRequestRequest{
			CourseId: courseID,
		})
		assertCode(t, err, connect.CodeAlreadyExists)

		// Remove the student so subsequent subtests can re-use courseID cleanly.
		if _, err := c.courseMembers.RemoveCourseMember(ctx, &richterv1.RemoveCourseMemberRequest{
			CourseId: courseID,
			UserId:   studentID,
		}); err != nil {
			t.Fatalf("cleanup: remove student from course: %v", err)
		}
	})

	// ── ReviewJoinRequest edge cases ──────────────────────────────────────────────

	t.Run("ReviewJoinRequest/Student_PermissionDenied", func(t *testing.T) {
		// A plain course-student (not a course manager) must not be able to review requests.
		// First submit a join request from the student so the course_id/user_id pair exists.
		if _, err := studentCM.CreateJoinRequest(ctx, &richterv1.CreateJoinRequestRequest{
			CourseId: courseID,
		}); err != nil {
			t.Fatalf("setup: student CreateJoinRequest: %v", err)
		}

		// Create a second user enrolled as a plain course-student to act as unauthorized reviewer.
		reviewer2Email, reviewer2Pass, reviewer2ID := createActiveUser(t, c.users)
		addOrgMember(t, c, orgID, reviewer2ID, richterv1.OrganizationRole_ORGANIZATION_ROLE_STUDENT)
		if _, err := c.courseMembers.AddCourseMember(ctx, &richterv1.AddCourseMemberRequest{
			CourseId: courseID,
			UserId:   reviewer2ID,
			Role:     richterv1.CourseRole_COURSE_ROLE_STUDENT,
		}); err != nil {
			t.Fatalf("setup: enrol reviewer2 as student: %v", err)
		}
		reviewer2Token := getUserToken(t, url, reviewer2Email, reviewer2Pass)
		reviewer2CM := richterv1connect.NewCourseMemberServiceClient(httpClientWithToken(reviewer2Token), url)

		_, err := reviewer2CM.ReviewJoinRequest(ctx, &richterv1.ReviewJoinRequestRequest{
			CourseId: courseID,
			UserId:   studentID,
			Approve:  true,
		})
		assertCode(t, err, connect.CodePermissionDenied)

		// Clean up: approve via teacher so studentID is enrolled for later subtests.
		if _, err := teacherCM.ReviewJoinRequest(ctx, &richterv1.ReviewJoinRequestRequest{
			CourseId: courseID,
			UserId:   studentID,
			Approve:  true,
		}); err != nil {
			t.Fatalf("cleanup: approve student request via teacher: %v", err)
		}
	})

	t.Run("ReviewJoinRequest/NoRequestExists_NotFound", func(t *testing.T) {
		// Reviewing a request for a user who has no pending request returns NotFound.
		_, _, noRequestUserID := createActiveUser(t, c.users)
		addOrgMember(t, c, orgID, noRequestUserID, richterv1.OrganizationRole_ORGANIZATION_ROLE_STUDENT)

		_, err := teacherCM.ReviewJoinRequest(ctx, &richterv1.ReviewJoinRequestRequest{
			CourseId: courseID,
			UserId:   noRequestUserID,
			Approve:  true,
		})
		assertCode(t, err, connect.CodeNotFound)
	})

	// ── ListPendingJoinRequests edge cases ────────────────────────────────────────

	t.Run("ListPendingJoinRequests/NonManager_PermissionDenied", func(t *testing.T) {
		// A plain org student (not a course manager) must be denied.
		nonMgrEmail, nonMgrPass, nonMgrID := createActiveUser(t, c.users)
		addOrgMember(t, c, orgID, nonMgrID, richterv1.OrganizationRole_ORGANIZATION_ROLE_STUDENT)
		// Intentionally do NOT enrol nonMgrID as a course member — keeps them non-manager.
		nonMgrToken := getUserToken(t, url, nonMgrEmail, nonMgrPass)
		nonMgrCM := richterv1connect.NewCourseMemberServiceClient(httpClientWithToken(nonMgrToken), url)

		_, err := nonMgrCM.ListPendingJoinRequests(ctx, &richterv1.ListPendingJoinRequestsRequest{
			CourseId: courseID,
			Limit:    10,
			Offset:   0,
		})
		assertCode(t, err, connect.CodePermissionDenied)
	})

	t.Run("ListPendingJoinRequests/Pagination", func(t *testing.T) {
		// Submit two fresh join requests and verify limit/offset pagination.
		for i := range 2 {
			email, pass, uid := createActiveUser(t, c.users)
			addOrgMember(t, c, orgID, uid, richterv1.OrganizationRole_ORGANIZATION_ROLE_STUDENT)
			tok := getUserToken(t, url, email, pass)
			cm := richterv1connect.NewCourseMemberServiceClient(httpClientWithToken(tok), url)
			if _, err := cm.CreateJoinRequest(ctx, &richterv1.CreateJoinRequestRequest{
				CourseId: courseID,
			}); err != nil {
				t.Fatalf("setup: CreateJoinRequest[%d]: %v", i, err)
			}
		}

		page1, err := teacherCM.ListPendingJoinRequests(ctx, &richterv1.ListPendingJoinRequestsRequest{
			CourseId: courseID,
			Limit:    1,
			Offset:   0,
		})
		if err != nil {
			t.Fatalf("ListPendingJoinRequests page1: %v", err)
		}
		if len(page1.Requests) != 1 {
			t.Errorf("expected 1 pending request on page1, got %d", len(page1.Requests))
		}

		page2, err := teacherCM.ListPendingJoinRequests(ctx, &richterv1.ListPendingJoinRequestsRequest{
			CourseId: courseID,
			Limit:    1,
			Offset:   1,
		})
		if err != nil {
			t.Fatalf("ListPendingJoinRequests page2: %v", err)
		}
		if len(page2.Requests) != 1 {
			t.Errorf("expected 1 pending request on page2, got %d", len(page2.Requests))
		}

		if page1.Requests[0].UserId == page2.Requests[0].UserId {
			t.Errorf("pagination returned the same user on both pages")
		}

		// Each row must include the user's email (JOIN with users table).
		for _, req := range append(page1.Requests, page2.Requests...) {
			if req.UserEmail == "" {
				t.Errorf("expected UserEmail populated for pending request user %s", req.UserId)
			}
		}
	})

	// ── GetMyJoinRequestStatus: self-scoped confirmation ──────────────────────────

	t.Run("GetMyJoinRequestStatus/AlwaysReturnsCaller", func(t *testing.T) {
		// The RPC ignores any implicit user context — it always reads claims.sub.
		// Create a fresh student whose request status is initially absent.
		freshEmail, freshPass, freshID := createActiveUser(t, c.users)
		addOrgMember(t, c, orgID, freshID, richterv1.OrganizationRole_ORGANIZATION_ROLE_STUDENT)
		freshToken := getUserToken(t, url, freshEmail, freshPass)
		freshCM := richterv1connect.NewCourseMemberServiceClient(httpClientWithToken(freshToken), url)

		// No request yet — must return a nil request field, not an error.
		res, err := freshCM.GetMyJoinRequestStatus(ctx, &richterv1.GetMyJoinRequestStatusRequest{
			CourseId: courseID,
		})
		if err != nil {
			t.Fatalf("GetMyJoinRequestStatus (no request): %v", err)
		}
		if res.GetRequest() != nil {
			t.Errorf("expected nil request for user with no join request, got status %v", res.GetRequest().GetStatus())
		}

		// Submit a request.
		if _, err := freshCM.CreateJoinRequest(ctx, &richterv1.CreateJoinRequestRequest{
			CourseId: courseID,
		}); err != nil {
			t.Fatalf("CreateJoinRequest: %v", err)
		}

		// Caller's own status must now be PENDING.
		res2, err := freshCM.GetMyJoinRequestStatus(ctx, &richterv1.GetMyJoinRequestStatusRequest{
			CourseId: courseID,
		})
		if err != nil {
			t.Fatalf("GetMyJoinRequestStatus (after create): %v", err)
		}
		if res2.GetRequest().GetStatus() != richterv1.JoinRequestStatus_JOIN_REQUEST_STATUS_PENDING {
			t.Errorf("expected PENDING, got %v", res2.GetRequest().GetStatus())
		}

		// The teacher calling GetMyJoinRequestStatus for the same course must see their
		// OWN status (teacher has no pending request), not freshID's status.
		teacherStatus, err := teacherCM.GetMyJoinRequestStatus(ctx, &richterv1.GetMyJoinRequestStatusRequest{
			CourseId: courseID,
		})
		if err != nil {
			t.Fatalf("GetMyJoinRequestStatus (teacher): %v", err)
		}
		// Teacher was directly enrolled, never submitted a join request.
		if teacherStatus.GetRequest() != nil {
			t.Errorf("teacher should have no join request, got status %v", teacherStatus.GetRequest().GetStatus())
		}
	})
}
