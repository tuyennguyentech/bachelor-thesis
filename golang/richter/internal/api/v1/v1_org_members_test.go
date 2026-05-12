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

type orgMembersTestClients struct {
	orgs       richterv1connect.OrganizationServiceClient
	orgMembers richterv1connect.OrganizationMemberServiceClient
	users      richterv1connect.UserServiceClient
}

func setupOrgMembersTestClients(t *testing.T) orgMembersTestClients {
	t.Helper()
	url := newV1Server(t)
	adminToken := getAdminToken(t, url)
	return orgMembersTestClients{
		orgs:       richterv1connect.NewOrganizationServiceClient(httpClientWithToken(adminToken), url),
		orgMembers: richterv1connect.NewOrganizationMemberServiceClient(httpClientWithToken(adminToken), url),
		users:      richterv1connect.NewUserServiceClient(httpClientWithToken(adminToken), url),
	}
}

func createTestUserForMembers(t *testing.T, c orgMembersTestClients) string {
	t.Helper()
	_, _, id := createActiveUser(t, c.users)
	return id
}

func createTestOrgForMembers(t *testing.T, c orgMembersTestClients, userID string) string {
	t.Helper()
	res, err := c.orgs.CreateOrganization(context.Background(), &richterv1.CreateOrganizationRequest{
		CreatedBy: userID,
		Name:      gofakeit.Company(),
		Slug:      testSlug(),
	})
	if err != nil {
		t.Fatalf("setup: failed to create organization: %v", err)
	}
	return res.Organization.Id
}

func TestOrgMemberValidation(t *testing.T) {
	c := setupOrgMembersTestClients(t)
	ctx := t.Context()
	userID := createTestUserForMembers(t, c)
	orgID := createTestOrgForMembers(t, c, userID)

	tests := []struct {
		name string
		req  *richterv1.AddOrganizationMemberRequest
	}{
		{
			name: "InvalidOrgUUID",
			req: &richterv1.AddOrganizationMemberRequest{
				OrganizationId: "not-a-uuid",
				UserId:         userID,
				Role:           richterv1.OrganizationRole_ORGANIZATION_ROLE_STUDENT,
				Status:         richterv1.MemberStatus_MEMBER_STATUS_ACTIVE,
			},
		},
		{
			name: "InvalidUserUUID",
			req: &richterv1.AddOrganizationMemberRequest{
				OrganizationId: orgID,
				UserId:         "not-a-uuid",
				Role:           richterv1.OrganizationRole_ORGANIZATION_ROLE_STUDENT,
				Status:         richterv1.MemberStatus_MEMBER_STATUS_ACTIVE,
			},
		},
		{
			name: "UnspecifiedRole",
			req: &richterv1.AddOrganizationMemberRequest{
				OrganizationId: orgID,
				UserId:         userID,
				Role:           richterv1.OrganizationRole_ORGANIZATION_ROLE_UNSPECIFIED,
				Status:         richterv1.MemberStatus_MEMBER_STATUS_ACTIVE,
			},
		},
		{
			name: "UnspecifiedStatus",
			req: &richterv1.AddOrganizationMemberRequest{
				OrganizationId: orgID,
				UserId:         userID,
				Role:           richterv1.OrganizationRole_ORGANIZATION_ROLE_STUDENT,
				Status:         richterv1.MemberStatus_MEMBER_STATUS_UNSPECIFIED,
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := c.orgMembers.AddOrganizationMember(ctx, tt.req)
			if err == nil {
				t.Error("expected error, got nil")
			} else if connect.CodeOf(err) != connect.CodeInvalidArgument {
				t.Errorf("expected code %v, got %v", connect.CodeInvalidArgument, connect.CodeOf(err))
			}
		})
	}
}

func TestOrgMemberLifecycle(t *testing.T) {
	c := setupOrgMembersTestClients(t)
	ctx := t.Context()
	ownerID := createTestUserForMembers(t, c)
	memberID := createTestUserForMembers(t, c)
	orgID := createTestOrgForMembers(t, c, ownerID)

	t.Run("AddOrganizationMember", func(t *testing.T) {
		res, err := c.orgMembers.AddOrganizationMember(ctx, &richterv1.AddOrganizationMemberRequest{
			OrganizationId: orgID,
			UserId:         memberID,
			Role:           richterv1.OrganizationRole_ORGANIZATION_ROLE_STUDENT,
			Status:         richterv1.MemberStatus_MEMBER_STATUS_INVITED,
		})
		if err != nil {
			t.Fatalf("failed to add member: %v", err)
		}
		if res.Member.Role != richterv1.OrganizationRole_ORGANIZATION_ROLE_STUDENT {
			t.Errorf("expected role STUDENT, got %v", res.Member.Role)
		}
		if res.Member.Status != richterv1.MemberStatus_MEMBER_STATUS_INVITED {
			t.Errorf("expected status INVITED, got %v", res.Member.Status)
		}
	})

	t.Run("GetOrganizationMember", func(t *testing.T) {
		res, err := c.orgMembers.GetOrganizationMember(ctx, &richterv1.GetOrganizationMemberRequest{
			OrganizationId: orgID,
			UserId:         memberID,
		})
		if err != nil {
			t.Fatalf("failed to get member: %v", err)
		}
		if res.Member.UserId != memberID {
			t.Errorf("expected user_id %s, got %s", memberID, res.Member.UserId)
		}
	})

	t.Run("ListOrganizationMembers", func(t *testing.T) {
		res, err := c.orgMembers.ListOrganizationMembers(ctx, &richterv1.ListOrganizationMembersRequest{
			OrganizationId: orgID,
			Limit:          10,
		})
		if err != nil {
			t.Fatalf("failed to list members: %v", err)
		}
		found := false
		for _, m := range res.Members {
			if m.UserId == memberID {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("member %s not found in list", memberID)
		}
	})

	t.Run("ListUserMemberships", func(t *testing.T) {
		res, err := c.orgMembers.ListUserMemberships(ctx, &richterv1.ListUserMembershipsRequest{
			UserId: memberID,
			Limit:  10,
		})
		if err != nil {
			t.Fatalf("failed to list memberships: %v", err)
		}
		found := false
		for _, m := range res.Members {
			if m.OrganizationId == orgID {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("organization %s not found in user memberships", orgID)
		}
	})

	t.Run("UpdateOrganizationMemberRole", func(t *testing.T) {
		res, err := c.orgMembers.UpdateOrganizationMemberRole(ctx, &richterv1.UpdateOrganizationMemberRoleRequest{
			OrganizationId: orgID,
			UserId:         memberID,
			Role:           richterv1.OrganizationRole_ORGANIZATION_ROLE_TEACHER,
		})
		if err != nil {
			t.Fatalf("failed to update member role: %v", err)
		}
		if res.Member.Role != richterv1.OrganizationRole_ORGANIZATION_ROLE_TEACHER {
			t.Errorf("expected role TEACHER, got %v", res.Member.Role)
		}
	})

	t.Run("UpdateOrganizationMemberStatus", func(t *testing.T) {
		res, err := c.orgMembers.UpdateOrganizationMemberStatus(ctx, &richterv1.UpdateOrganizationMemberStatusRequest{
			OrganizationId: orgID,
			UserId:         memberID,
			Status:         richterv1.MemberStatus_MEMBER_STATUS_ACTIVE,
		})
		if err != nil {
			t.Fatalf("failed to update member status: %v", err)
		}
		if res.Member.Status != richterv1.MemberStatus_MEMBER_STATUS_ACTIVE {
			t.Errorf("expected status ACTIVE, got %v", res.Member.Status)
		}
	})

	t.Run("RemoveOrganizationMember", func(t *testing.T) {
		_, err := c.orgMembers.RemoveOrganizationMember(ctx, &richterv1.RemoveOrganizationMemberRequest{
			OrganizationId: orgID,
			UserId:         memberID,
		})
		if err != nil {
			t.Fatalf("failed to remove member: %v", err)
		}
	})

	t.Run("VerifyRemoved", func(t *testing.T) {
		_, err := c.orgMembers.GetOrganizationMember(ctx, &richterv1.GetOrganizationMemberRequest{
			OrganizationId: orgID,
			UserId:         memberID,
		})
		if err == nil {
			t.Error("expected error getting removed member, got nil")
		} else if connect.CodeOf(err) != connect.CodeNotFound {
			t.Errorf("expected code %v, got %v", connect.CodeNotFound, connect.CodeOf(err))
		}
	})
}

func TestOrgMemberErrors(t *testing.T) {
	c := setupOrgMembersTestClients(t)
	ctx := t.Context()
	ownerID := createTestUserForMembers(t, c)
	memberID := createTestUserForMembers(t, c)
	orgID := createTestOrgForMembers(t, c, ownerID)

	_, err := c.orgMembers.AddOrganizationMember(ctx, &richterv1.AddOrganizationMemberRequest{
		OrganizationId: orgID,
		UserId:         memberID,
		Role:           richterv1.OrganizationRole_ORGANIZATION_ROLE_STUDENT,
		Status:         richterv1.MemberStatus_MEMBER_STATUS_ACTIVE,
	})
	if err != nil {
		t.Fatalf("setup: failed to add member: %v", err)
	}

	t.Run("DuplicateMember", func(t *testing.T) {
		_, err := c.orgMembers.AddOrganizationMember(ctx, &richterv1.AddOrganizationMemberRequest{
			OrganizationId: orgID,
			UserId:         memberID,
			Role:           richterv1.OrganizationRole_ORGANIZATION_ROLE_STUDENT,
			Status:         richterv1.MemberStatus_MEMBER_STATUS_ACTIVE,
		})
		if err == nil {
			t.Error("expected error for duplicate member, got nil")
		} else if connect.CodeOf(err) != connect.CodeAlreadyExists {
			t.Errorf("expected code %v, got %v", connect.CodeAlreadyExists, connect.CodeOf(err))
		}
	})

	t.Run("MemberNotFound", func(t *testing.T) {
		_, err := c.orgMembers.GetOrganizationMember(ctx, &richterv1.GetOrganizationMemberRequest{
			OrganizationId: orgID,
			UserId:         gofakeit.UUID(),
		})
		if err == nil {
			t.Error("expected error for non-existent member, got nil")
		} else if connect.CodeOf(err) != connect.CodeNotFound {
			t.Errorf("expected code %v, got %v", connect.CodeNotFound, connect.CodeOf(err))
		}
	})

	t.Run("RemoveNonExistentMember", func(t *testing.T) {
		_, err := c.orgMembers.RemoveOrganizationMember(ctx, &richterv1.RemoveOrganizationMemberRequest{
			OrganizationId: orgID,
			UserId:         gofakeit.UUID(),
		})
		if err == nil {
			t.Error("expected error removing non-existent member, got nil")
		} else if connect.CodeOf(err) != connect.CodeNotFound {
			t.Errorf("expected code %v, got %v", connect.CodeNotFound, connect.CodeOf(err))
		}
	})
}

func TestOrgMembersAuthz(t *testing.T) {
	url := newV1Server(t)
	ctx := context.Background()
	adminToken := getAdminToken(t, url)

	adminUsers := richterv1connect.NewUserServiceClient(httpClientWithToken(adminToken), url)
	adminOrgs := richterv1connect.NewOrganizationServiceClient(httpClientWithToken(adminToken), url)
	adminMembers := richterv1connect.NewOrganizationMemberServiceClient(httpClientWithToken(adminToken), url)
	anonMembers := richterv1connect.NewOrganizationMemberServiceClient(http.DefaultClient, url)

	// users with various org roles
	ownerEmail, ownerPass, ownerID := createActiveUser(t, adminUsers)
	ownerToken := getUserToken(t, url, ownerEmail, ownerPass)

	orgAdminEmail, orgAdminPass, orgAdminID := createActiveUser(t, adminUsers)
	orgAdminToken := getUserToken(t, url, orgAdminEmail, orgAdminPass)

	teacherEmail, teacherPass, teacherID := createActiveUser(t, adminUsers)
	teacherToken := getUserToken(t, url, teacherEmail, teacherPass)

	studentEmail, studentPass, studentID := createActiveUser(t, adminUsers)
	studentToken := getUserToken(t, url, studentEmail, studentPass)

	nonMemberEmail, nonMemberPass, nonMemberID := createActiveUser(t, adminUsers)
	nonMemberToken := getUserToken(t, url, nonMemberEmail, nonMemberPass)
	_ = nonMemberID

	// create the org (owner creates it and becomes OWNER automatically)
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

	// populate initial members via admin
	for _, m := range []struct {
		userID string
		role   richterv1.OrganizationRole
	}{
		{orgAdminID, richterv1.OrganizationRole_ORGANIZATION_ROLE_ADMIN},
		{teacherID, richterv1.OrganizationRole_ORGANIZATION_ROLE_TEACHER},
		{studentID, richterv1.OrganizationRole_ORGANIZATION_ROLE_STUDENT},
	} {
		if _, err := adminMembers.AddOrganizationMember(ctx, &richterv1.AddOrganizationMemberRequest{
			OrganizationId: orgID, UserId: m.userID,
			Role: m.role, Status: richterv1.MemberStatus_MEMBER_STATUS_ACTIVE,
		}); err != nil {
			t.Fatalf("setup: add member %s: %v", m.userID, err)
		}
	}

	ownerMembers := richterv1connect.NewOrganizationMemberServiceClient(httpClientWithToken(ownerToken), url)
	orgAdminMembers := richterv1connect.NewOrganizationMemberServiceClient(httpClientWithToken(orgAdminToken), url)
	teacherMembers := richterv1connect.NewOrganizationMemberServiceClient(httpClientWithToken(teacherToken), url)
	studentMembers := richterv1connect.NewOrganizationMemberServiceClient(httpClientWithToken(studentToken), url)
	nonMemberMembers := richterv1connect.NewOrganizationMemberServiceClient(httpClientWithToken(nonMemberToken), url)

	// --- AddOrganizationMember ---
	t.Run("AddOrganizationMember", func(t *testing.T) {
		extraEmail, extraPass, extraID := createActiveUser(t, adminUsers)
		_ = extraEmail
		_ = extraPass
		addReq := func() *richterv1.AddOrganizationMemberRequest {
			return &richterv1.AddOrganizationMemberRequest{
				OrganizationId: orgID, UserId: extraID,
				Role: richterv1.OrganizationRole_ORGANIZATION_ROLE_STUDENT,
				Status: richterv1.MemberStatus_MEMBER_STATUS_ACTIVE,
			}
		}
		t.Run("Anon/Unauthenticated", func(t *testing.T) {
			assertCode(t, func() error { _, e := anonMembers.AddOrganizationMember(ctx, addReq()); return e }(), connect.CodeUnauthenticated)
		})
		t.Run("Student/PermissionDenied", func(t *testing.T) {
			assertCode(t, func() error { _, e := studentMembers.AddOrganizationMember(ctx, addReq()); return e }(), connect.CodePermissionDenied)
		})
		t.Run("Teacher/PermissionDenied", func(t *testing.T) {
			assertCode(t, func() error { _, e := teacherMembers.AddOrganizationMember(ctx, addReq()); return e }(), connect.CodePermissionDenied)
		})
		t.Run("OrgAdmin/OK", func(t *testing.T) {
			if _, err := orgAdminMembers.AddOrganizationMember(ctx, addReq()); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
	})

	// --- GetOrganizationMember ---
	t.Run("GetOrganizationMember", func(t *testing.T) {
		req := &richterv1.GetOrganizationMemberRequest{OrganizationId: orgID, UserId: studentID}
		t.Run("Anon/Unauthenticated", func(t *testing.T) {
			assertCode(t, func() error { _, e := anonMembers.GetOrganizationMember(ctx, req); return e }(), connect.CodeUnauthenticated)
		})
		t.Run("NonMember/PermissionDenied", func(t *testing.T) {
			assertCode(t, func() error { _, e := nonMemberMembers.GetOrganizationMember(ctx, req); return e }(), connect.CodePermissionDenied)
		})
		t.Run("Member/OK", func(t *testing.T) {
			if _, err := studentMembers.GetOrganizationMember(ctx, req); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
	})

	// --- ListOrganizationMembers ---
	t.Run("ListOrganizationMembers", func(t *testing.T) {
		req := &richterv1.ListOrganizationMembersRequest{OrganizationId: orgID, Limit: 10}
		t.Run("Anon/Unauthenticated", func(t *testing.T) {
			assertCode(t, func() error { _, e := anonMembers.ListOrganizationMembers(ctx, req); return e }(), connect.CodeUnauthenticated)
		})
		t.Run("NonMember/PermissionDenied", func(t *testing.T) {
			assertCode(t, func() error { _, e := nonMemberMembers.ListOrganizationMembers(ctx, req); return e }(), connect.CodePermissionDenied)
		})
		t.Run("Member/OK", func(t *testing.T) {
			if _, err := teacherMembers.ListOrganizationMembers(ctx, req); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
	})

	// --- ListUserMemberships ---
	t.Run("ListUserMemberships", func(t *testing.T) {
		req := &richterv1.ListUserMembershipsRequest{UserId: studentID, Limit: 10}
		t.Run("Anon/Unauthenticated", func(t *testing.T) {
			assertCode(t, func() error { _, e := anonMembers.ListUserMemberships(ctx, req); return e }(), connect.CodeUnauthenticated)
		})
		t.Run("OtherUser/PermissionDenied", func(t *testing.T) {
			assertCode(t, func() error { _, e := teacherMembers.ListUserMemberships(ctx, req); return e }(), connect.CodePermissionDenied)
		})
		t.Run("Self/OK", func(t *testing.T) {
			if _, err := studentMembers.ListUserMemberships(ctx, req); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
		t.Run("Admin/OK", func(t *testing.T) {
			if _, err := adminMembers.ListUserMemberships(ctx, req); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
	})

	// --- UpdateOrganizationMemberRole ---
	t.Run("UpdateOrganizationMemberRole", func(t *testing.T) {
		// change teacher's role (teacher is not OWNER, so org admin can change it)
		req := &richterv1.UpdateOrganizationMemberRoleRequest{
			OrganizationId: orgID, UserId: teacherID,
			Role: richterv1.OrganizationRole_ORGANIZATION_ROLE_TEACHER,
		}
		t.Run("Anon/Unauthenticated", func(t *testing.T) {
			assertCode(t, func() error { _, e := anonMembers.UpdateOrganizationMemberRole(ctx, req); return e }(), connect.CodeUnauthenticated)
		})
		t.Run("NonMember/PermissionDenied", func(t *testing.T) {
			assertCode(t, func() error { _, e := nonMemberMembers.UpdateOrganizationMemberRole(ctx, req); return e }(), connect.CodePermissionDenied)
		})
		t.Run("Student/PermissionDenied", func(t *testing.T) {
			assertCode(t, func() error { _, e := studentMembers.UpdateOrganizationMemberRole(ctx, req); return e }(), connect.CodePermissionDenied)
		})
		t.Run("Teacher/PermissionDenied", func(t *testing.T) {
			assertCode(t, func() error { _, e := teacherMembers.UpdateOrganizationMemberRole(ctx, req); return e }(), connect.CodePermissionDenied)
		})
		t.Run("OrgAdmin/OK", func(t *testing.T) {
			if _, err := orgAdminMembers.UpdateOrganizationMemberRole(ctx, req); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
		t.Run("OrgAdmin/OwnerTarget/PermissionDenied", func(t *testing.T) {
			// org admin cannot change an owner's role
			ownerReq := &richterv1.UpdateOrganizationMemberRoleRequest{
				OrganizationId: orgID, UserId: ownerID,
				Role: richterv1.OrganizationRole_ORGANIZATION_ROLE_ADMIN,
			}
			assertCode(t, func() error { _, e := orgAdminMembers.UpdateOrganizationMemberRole(ctx, ownerReq); return e }(), connect.CodePermissionDenied)
		})
		t.Run("OrgOwner/OwnerTarget/OK", func(t *testing.T) {
			ownerReq := &richterv1.UpdateOrganizationMemberRoleRequest{
				OrganizationId: orgID, UserId: ownerID,
				Role: richterv1.OrganizationRole_ORGANIZATION_ROLE_OWNER,
			}
			if _, err := ownerMembers.UpdateOrganizationMemberRole(ctx, ownerReq); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
	})

	// --- UpdateOrganizationMemberStatus ---
	t.Run("UpdateOrganizationMemberStatus", func(t *testing.T) {
		req := &richterv1.UpdateOrganizationMemberStatusRequest{
			OrganizationId: orgID, UserId: studentID,
			Status: richterv1.MemberStatus_MEMBER_STATUS_ACTIVE,
		}
		t.Run("Anon/Unauthenticated", func(t *testing.T) {
			assertCode(t, func() error { _, e := anonMembers.UpdateOrganizationMemberStatus(ctx, req); return e }(), connect.CodeUnauthenticated)
		})
		t.Run("NonMember/PermissionDenied", func(t *testing.T) {
			assertCode(t, func() error { _, e := nonMemberMembers.UpdateOrganizationMemberStatus(ctx, req); return e }(), connect.CodePermissionDenied)
		})
		t.Run("Student/PermissionDenied", func(t *testing.T) {
			assertCode(t, func() error { _, e := studentMembers.UpdateOrganizationMemberStatus(ctx, req); return e }(), connect.CodePermissionDenied)
		})
		t.Run("Teacher/PermissionDenied", func(t *testing.T) {
			assertCode(t, func() error { _, e := teacherMembers.UpdateOrganizationMemberStatus(ctx, req); return e }(), connect.CodePermissionDenied)
		})
		t.Run("OrgAdmin/OK", func(t *testing.T) {
			if _, err := orgAdminMembers.UpdateOrganizationMemberStatus(ctx, req); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
		t.Run("OrgOwner/OK", func(t *testing.T) {
			if _, err := ownerMembers.UpdateOrganizationMemberStatus(ctx, req); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
	})

	// --- RemoveOrganizationMember ---
	t.Run("RemoveOrganizationMember", func(t *testing.T) {
		t.Run("Anon/Unauthenticated", func(t *testing.T) {
			assertCode(t, func() error {
				_, e := anonMembers.RemoveOrganizationMember(ctx, &richterv1.RemoveOrganizationMemberRequest{
					OrganizationId: orgID, UserId: studentID,
				})
				return e
			}(), connect.CodeUnauthenticated)
		})
		t.Run("NonMember/PermissionDenied", func(t *testing.T) {
			assertCode(t, func() error {
				_, e := nonMemberMembers.RemoveOrganizationMember(ctx, &richterv1.RemoveOrganizationMemberRequest{
					OrganizationId: orgID, UserId: studentID,
				})
				return e
			}(), connect.CodePermissionDenied)
		})
		t.Run("Student/CannotRemoveOther", func(t *testing.T) {
			// student tries to remove teacher → PermissionDenied
			assertCode(t, func() error {
				_, e := studentMembers.RemoveOrganizationMember(ctx, &richterv1.RemoveOrganizationMemberRequest{
					OrganizationId: orgID, UserId: teacherID,
				})
				return e
			}(), connect.CodePermissionDenied)
		})
		t.Run("OrgAdmin/CannotRemoveOwner", func(t *testing.T) {
			assertCode(t, func() error {
				_, e := orgAdminMembers.RemoveOrganizationMember(ctx, &richterv1.RemoveOrganizationMemberRequest{
					OrganizationId: orgID, UserId: ownerID,
				})
				return e
			}(), connect.CodePermissionDenied)
		})
		t.Run("OrgOwner/CanRemoveAdmin", func(t *testing.T) {
			// owner can remove org admin; add a disposable org admin first
			dispEmail, dispPass, dispID := createActiveUser(t, adminUsers)
			_ = dispEmail
			_ = dispPass
			if _, err := adminMembers.AddOrganizationMember(ctx, &richterv1.AddOrganizationMemberRequest{
				OrganizationId: orgID, UserId: dispID,
				Role: richterv1.OrganizationRole_ORGANIZATION_ROLE_ADMIN,
				Status: richterv1.MemberStatus_MEMBER_STATUS_ACTIVE,
			}); err != nil {
				t.Fatalf("setup: add disposable admin: %v", err)
			}
			if _, err := ownerMembers.RemoveOrganizationMember(ctx, &richterv1.RemoveOrganizationMemberRequest{
				OrganizationId: orgID, UserId: dispID,
			}); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
		t.Run("Student/CanRemoveSelf", func(t *testing.T) {
			if _, err := studentMembers.RemoveOrganizationMember(ctx, &richterv1.RemoveOrganizationMemberRequest{
				OrganizationId: orgID, UserId: studentID,
			}); err != nil {
				t.Errorf("student should be able to remove self, got %v", err)
			}
		})
	})

	// ensure adminOrgs, adminOrgs is used
	_ = adminOrgs
}
