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

type orgsTestClients struct {
	orgs  richterv1connect.OrganizationServiceClient
	users richterv1connect.UserServiceClient
}

func setupOrgsTestClients(t *testing.T) orgsTestClients {
	t.Helper()
	url := newV1Server(t)
	adminToken := getAdminToken(t, url)
	return orgsTestClients{
		orgs:  richterv1connect.NewOrganizationServiceClient(httpClientWithToken(adminToken), url),
		users: richterv1connect.NewUserServiceClient(httpClientWithToken(adminToken), url),
	}
}

func createTestUser(t *testing.T, c orgsTestClients) string {
	t.Helper()
	_, _, id := createActiveUser(t, c.users)
	return id
}

func TestOrganizationValidation(t *testing.T) {
	c := setupOrgsTestClients(t)
	ctx := t.Context()
	userID := createTestUser(t, c)

	tests := []struct {
		name string
		req  *richterv1.CreateOrganizationRequest
	}{
		{
			name: "InvalidCreatedByUUID",
			req: &richterv1.CreateOrganizationRequest{
				CreatedBy: "not-a-uuid",
				Name:      gofakeit.Company(),
				Slug:      "valid-slug",
			},
		},
		{
			name: "EmptyName",
			req: &richterv1.CreateOrganizationRequest{
				CreatedBy: userID,
				Name:      "",
				Slug:      "valid-slug",
			},
		},
		{
			name: "InvalidSlugPattern",
			req: &richterv1.CreateOrganizationRequest{
				CreatedBy: userID,
				Name:      gofakeit.Company(),
				Slug:      "Invalid Slug!",
			},
		},
		{
			name: "EmptySlug",
			req: &richterv1.CreateOrganizationRequest{
				CreatedBy: userID,
				Name:      gofakeit.Company(),
				Slug:      "",
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := c.orgs.CreateOrganization(ctx, tt.req)
			if err == nil {
				t.Error("expected error, got nil")
			} else if connect.CodeOf(err) != connect.CodeInvalidArgument {
				t.Errorf("expected code %v, got %v", connect.CodeInvalidArgument, connect.CodeOf(err))
			}
		})
	}
}

func TestOrganizationLifecycle(t *testing.T) {
	c := setupOrgsTestClients(t)
	ctx := t.Context()
	userID := createTestUser(t, c)

	name := gofakeit.Company()
	slug := testSlug()
	var orgID string

	t.Run("CreateOrganization", func(t *testing.T) {
		res, err := c.orgs.CreateOrganization(ctx, &richterv1.CreateOrganizationRequest{
			CreatedBy: userID,
			Name:      name,
			Slug:      slug,
		})
		if err != nil {
			t.Fatalf("failed to create organization: %v", err)
		}
		if res.Organization.Name != name {
			t.Errorf("expected name %s, got %s", name, res.Organization.Name)
		}
		if res.Organization.Slug != slug {
			t.Errorf("expected slug %s, got %s", slug, res.Organization.Slug)
		}
		if res.Organization.Status != richterv1.OrganizationStatus_ORGANIZATION_STATUS_ACTIVE {
			t.Errorf("expected status ACTIVE, got %v", res.Organization.Status)
		}
		orgID = res.Organization.Id
	})

	t.Run("GetOrganizationById", func(t *testing.T) {
		res, err := c.orgs.GetOrganizationById(ctx, &richterv1.GetOrganizationByIdRequest{
			Id: orgID,
		})
		if err != nil {
			t.Fatalf("failed to get organization by id: %v", err)
		}
		if res.Organization.Id != orgID {
			t.Errorf("expected id %s, got %s", orgID, res.Organization.Id)
		}
	})

	t.Run("GetOrganizationBySlug", func(t *testing.T) {
		res, err := c.orgs.GetOrganizationBySlug(ctx, &richterv1.GetOrganizationBySlugRequest{
			Slug: slug,
		})
		if err != nil {
			t.Fatalf("failed to get organization by slug: %v", err)
		}
		if res.Organization.Id != orgID {
			t.Errorf("expected id %s, got %s", orgID, res.Organization.Id)
		}
	})

	t.Run("ListOrganizations", func(t *testing.T) {
		res, err := c.orgs.ListOrganizations(ctx, &richterv1.ListOrganizationsRequest{
			Limit: 10,
		})
		if err != nil {
			t.Fatalf("failed to list organizations: %v", err)
		}
		found := false
		for _, o := range res.Organizations {
			if o.Id == orgID {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("organization %s not found in list", orgID)
		}
	})

	t.Run("ListOrganizationsByUser", func(t *testing.T) {
		res, err := c.orgs.ListOrganizationsByUser(ctx, &richterv1.ListOrganizationsByUserRequest{
			UserId: userID,
			Limit:  10,
		})
		if err != nil {
			t.Fatalf("failed to list organizations by user: %v", err)
		}
		found := false
		for _, o := range res.Organizations {
			if o.Id == orgID {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("organization %s not found in user's list", orgID)
		}
	})

	t.Run("UpdateOrganization", func(t *testing.T) {
		newName := gofakeit.Company()
		newSlug := testSlug()
		res, err := c.orgs.UpdateOrganization(ctx, &richterv1.UpdateOrganizationRequest{
			Id:   orgID,
			Name: newName,
			Slug: newSlug,
		})
		if err != nil {
			t.Fatalf("failed to update organization: %v", err)
		}
		if res.Organization.Name != newName {
			t.Errorf("expected name %s, got %s", newName, res.Organization.Name)
		}
		if res.Organization.Slug != newSlug {
			t.Errorf("expected slug %s, got %s", newSlug, res.Organization.Slug)
		}
		slug = newSlug
	})

	t.Run("UpdateOrganizationStatus", func(t *testing.T) {
		res, err := c.orgs.UpdateOrganizationStatus(ctx, &richterv1.UpdateOrganizationStatusRequest{
			Id:     orgID,
			Status: richterv1.OrganizationStatus_ORGANIZATION_STATUS_SUSPENDED,
		})
		if err != nil {
			t.Fatalf("failed to update organization status: %v", err)
		}
		if res.Organization.Status != richterv1.OrganizationStatus_ORGANIZATION_STATUS_SUSPENDED {
			t.Errorf("expected status SUSPENDED, got %v", res.Organization.Status)
		}
	})

	t.Run("DeleteOrganization", func(t *testing.T) {
		_, err := c.orgs.DeleteOrganization(ctx, &richterv1.DeleteOrganizationRequest{
			Id: orgID,
		})
		if err != nil {
			t.Fatalf("failed to delete organization: %v", err)
		}
	})

	t.Run("VerifyDeleted", func(t *testing.T) {
		_, err := c.orgs.GetOrganizationById(ctx, &richterv1.GetOrganizationByIdRequest{
			Id: orgID,
		})
		if err == nil {
			t.Error("expected error getting deleted organization, got nil")
		} else if connect.CodeOf(err) != connect.CodeNotFound {
			t.Errorf("expected code %v, got %v", connect.CodeNotFound, connect.CodeOf(err))
		}
	})
}

func TestOrganizationErrors(t *testing.T) {
	c := setupOrgsTestClients(t)
	ctx := t.Context()
	userID := createTestUser(t, c)

	slug := testSlug()
	_, err := c.orgs.CreateOrganization(ctx, &richterv1.CreateOrganizationRequest{
		CreatedBy: userID,
		Name:      gofakeit.Company(),
		Slug:      slug,
	})
	if err != nil {
		t.Fatalf("setup: failed to create organization: %v", err)
	}

	t.Run("DuplicateSlug", func(t *testing.T) {
		_, err := c.orgs.CreateOrganization(ctx, &richterv1.CreateOrganizationRequest{
			CreatedBy: userID,
			Name:      gofakeit.Company(),
			Slug:      slug,
		})
		if err == nil {
			t.Error("expected error for duplicate slug, got nil")
		} else if connect.CodeOf(err) != connect.CodeAlreadyExists {
			t.Errorf("expected code %v, got %v", connect.CodeAlreadyExists, connect.CodeOf(err))
		}
	})

	t.Run("NotFound", func(t *testing.T) {
		_, err := c.orgs.GetOrganizationById(ctx, &richterv1.GetOrganizationByIdRequest{
			Id: gofakeit.UUID(),
		})
		if err == nil {
			t.Error("expected error for non-existent organization, got nil")
		} else if connect.CodeOf(err) != connect.CodeNotFound {
			t.Errorf("expected code %v, got %v", connect.CodeNotFound, connect.CodeOf(err))
		}
	})

	t.Run("SlugNotFoundReturnsPermissionDenied", func(t *testing.T) {
		// GetOrganizationBySlug returns PermissionDenied (not NotFound) for any non-existent
		// slug to prevent authenticated users from enumerating valid org slugs.
		_, err := c.orgs.GetOrganizationBySlug(ctx, &richterv1.GetOrganizationBySlugRequest{
			Slug: testSlug(),
		})
		if err == nil {
			t.Error("expected error for non-existent slug, got nil")
		} else if connect.CodeOf(err) != connect.CodePermissionDenied {
			t.Errorf("expected code %v (slug enumeration prevention), got %v", connect.CodePermissionDenied, connect.CodeOf(err))
		}
	})
}

func TestOrgsAuthz(t *testing.T) {
	url := newV1Server(t)
	ctx := context.Background()
	adminToken := getAdminToken(t, url)

	adminUsers := richterv1connect.NewUserServiceClient(httpClientWithToken(adminToken), url)
	adminOrgs := richterv1connect.NewOrganizationServiceClient(httpClientWithToken(adminToken), url)
	anonOrgs := richterv1connect.NewOrganizationServiceClient(http.DefaultClient, url)

	// owner: creates the org and becomes OWNER
	ownerEmail, ownerPass, ownerID := createActiveUser(t, adminUsers)
	ownerToken := getUserToken(t, url, ownerEmail, ownerPass)
	ownerOrgs := richterv1connect.NewOrganizationServiceClient(httpClientWithToken(ownerToken), url)

	// student: will be added as STUDENT in the org
	studentEmail, studentPass, studentID := createActiveUser(t, adminUsers)
	studentToken := getUserToken(t, url, studentEmail, studentPass)
	studentOrgs := richterv1connect.NewOrganizationServiceClient(httpClientWithToken(studentToken), url)

	// orgAdmin: will be added as ORG_ADMIN in the org
	orgAdminEmail, orgAdminPass, orgAdminID := createActiveUser(t, adminUsers)
	orgAdminToken := getUserToken(t, url, orgAdminEmail, orgAdminPass)
	orgAdminOrgs := richterv1connect.NewOrganizationServiceClient(httpClientWithToken(orgAdminToken), url)

	// nonMember: authenticated but not a member of the org
	nonMemberEmail, nonMemberPass, _ := createActiveUser(t, adminUsers)
	nonMemberToken := getUserToken(t, url, nonMemberEmail, nonMemberPass)
	nonMemberOrgs := richterv1connect.NewOrganizationServiceClient(httpClientWithToken(nonMemberToken), url)

	// create the org (admin can act as owner of any user via RequireSelf bypass)
	orgSlug := testSlug()
	createOrgRes, err := ownerOrgs.CreateOrganization(ctx, &richterv1.CreateOrganizationRequest{
		CreatedBy: ownerID,
		Name:      gofakeit.Company(),
		Slug:      orgSlug,
	})
	if err != nil {
		t.Fatalf("setup: create org: %v", err)
	}
	orgID := createOrgRes.Organization.Id

	// add student and orgAdmin as org members (admin can add members)
	adminOrgMembers := richterv1connect.NewOrganizationMemberServiceClient(httpClientWithToken(adminToken), url)
	if _, err := adminOrgMembers.AddOrganizationMember(ctx, &richterv1.AddOrganizationMemberRequest{
		OrganizationId: orgID, UserId: studentID,
		Role: richterv1.OrganizationRole_ORGANIZATION_ROLE_STUDENT, Status: richterv1.MemberStatus_MEMBER_STATUS_ACTIVE,
	}); err != nil {
		t.Fatalf("setup: add student: %v", err)
	}
	if _, err := adminOrgMembers.AddOrganizationMember(ctx, &richterv1.AddOrganizationMemberRequest{
		OrganizationId: orgID, UserId: orgAdminID,
		Role: richterv1.OrganizationRole_ORGANIZATION_ROLE_ADMIN, Status: richterv1.MemberStatus_MEMBER_STATUS_ACTIVE,
	}); err != nil {
		t.Fatalf("setup: add org admin: %v", err)
	}

	t.Run("CreateOrganization", func(t *testing.T) {
		t.Run("Anon/Unauthenticated", func(t *testing.T) {
			assertCode(t, func() error {
				_, e := anonOrgs.CreateOrganization(ctx, &richterv1.CreateOrganizationRequest{
					CreatedBy: ownerID, Name: "X", Slug: "anon-org-test",
				})
				return e
			}(), connect.CodeUnauthenticated)
		})
		t.Run("OtherUser/PermissionDenied", func(t *testing.T) {
			// student tries to create org with ownerID as creator → PermissionDenied (not self)
			assertCode(t, func() error {
				_, e := studentOrgs.CreateOrganization(ctx, &richterv1.CreateOrganizationRequest{
					CreatedBy: ownerID, Name: "Y", Slug: "student-org-test",
				})
				return e
			}(), connect.CodePermissionDenied)
		})
		t.Run("Self/OK", func(t *testing.T) {
			slug := testSlug()
			if _, err := ownerOrgs.CreateOrganization(ctx, &richterv1.CreateOrganizationRequest{
				CreatedBy: ownerID, Name: "Self Org", Slug: slug,
			}); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
		t.Run("Admin/OK", func(t *testing.T) {
			slug := testSlug()
			if _, err := adminOrgs.CreateOrganization(ctx, &richterv1.CreateOrganizationRequest{
				CreatedBy: ownerID, Name: "Admin Org", Slug: slug,
			}); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
	})

	t.Run("GetOrganizationById", func(t *testing.T) {
		req := &richterv1.GetOrganizationByIdRequest{Id: orgID}
		t.Run("Anon/Unauthenticated", func(t *testing.T) {
			assertCode(t, func() error { _, e := anonOrgs.GetOrganizationById(ctx, req); return e }(), connect.CodeUnauthenticated)
		})
		t.Run("NonMember/PermissionDenied", func(t *testing.T) {
			assertCode(t, func() error { _, e := nonMemberOrgs.GetOrganizationById(ctx, req); return e }(), connect.CodePermissionDenied)
		})
		t.Run("Member/OK", func(t *testing.T) {
			if _, err := studentOrgs.GetOrganizationById(ctx, req); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
		t.Run("Admin/OK", func(t *testing.T) {
			if _, err := adminOrgs.GetOrganizationById(ctx, req); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
	})

	t.Run("GetOrganizationBySlug", func(t *testing.T) {
		req := &richterv1.GetOrganizationBySlugRequest{Slug: orgSlug}
		t.Run("Anon/Unauthenticated", func(t *testing.T) {
			assertCode(t, func() error { _, e := anonOrgs.GetOrganizationBySlug(ctx, req); return e }(), connect.CodeUnauthenticated)
		})
		t.Run("NonMember/PermissionDenied", func(t *testing.T) {
			assertCode(t, func() error { _, e := nonMemberOrgs.GetOrganizationBySlug(ctx, req); return e }(), connect.CodePermissionDenied)
		})
		t.Run("Member/OK", func(t *testing.T) {
			if _, err := studentOrgs.GetOrganizationBySlug(ctx, req); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
		t.Run("Admin/OK", func(t *testing.T) {
			if _, err := adminOrgs.GetOrganizationBySlug(ctx, req); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
	})

	t.Run("ListOrganizations", func(t *testing.T) {
		req := &richterv1.ListOrganizationsRequest{Limit: 10}
		t.Run("Anon/Unauthenticated", func(t *testing.T) {
			assertCode(t, func() error { _, e := anonOrgs.ListOrganizations(ctx, req); return e }(), connect.CodeUnauthenticated)
		})
		t.Run("User/PermissionDenied", func(t *testing.T) {
			assertCode(t, func() error { _, e := studentOrgs.ListOrganizations(ctx, req); return e }(), connect.CodePermissionDenied)
		})
		t.Run("Admin/OK", func(t *testing.T) {
			if _, err := adminOrgs.ListOrganizations(ctx, req); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
	})

	t.Run("ListOrganizationsByUser", func(t *testing.T) {
		req := &richterv1.ListOrganizationsByUserRequest{UserId: ownerID, Limit: 10}
		t.Run("Anon/Unauthenticated", func(t *testing.T) {
			assertCode(t, func() error { _, e := anonOrgs.ListOrganizationsByUser(ctx, req); return e }(), connect.CodeUnauthenticated)
		})
		t.Run("OtherUser/PermissionDenied", func(t *testing.T) {
			assertCode(t, func() error { _, e := studentOrgs.ListOrganizationsByUser(ctx, req); return e }(), connect.CodePermissionDenied)
		})
		t.Run("Self/OK", func(t *testing.T) {
			if _, err := ownerOrgs.ListOrganizationsByUser(ctx, req); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
		t.Run("Admin/OK", func(t *testing.T) {
			if _, err := adminOrgs.ListOrganizationsByUser(ctx, req); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
	})

	updateReq := &richterv1.UpdateOrganizationRequest{Id: orgID, Name: "Updated", Slug: orgSlug}

	t.Run("UpdateOrganization", func(t *testing.T) {
		t.Run("Anon/Unauthenticated", func(t *testing.T) {
			assertCode(t, func() error { _, e := anonOrgs.UpdateOrganization(ctx, updateReq); return e }(), connect.CodeUnauthenticated)
		})
		t.Run("NonMember/PermissionDenied", func(t *testing.T) {
			assertCode(t, func() error { _, e := nonMemberOrgs.UpdateOrganization(ctx, updateReq); return e }(), connect.CodePermissionDenied)
		})
		t.Run("Student/PermissionDenied", func(t *testing.T) {
			assertCode(t, func() error { _, e := studentOrgs.UpdateOrganization(ctx, updateReq); return e }(), connect.CodePermissionDenied)
		})
		t.Run("OrgAdmin/OK", func(t *testing.T) {
			if _, err := orgAdminOrgs.UpdateOrganization(ctx, updateReq); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
		t.Run("OrgOwner/OK", func(t *testing.T) {
			if _, err := ownerOrgs.UpdateOrganization(ctx, updateReq); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
	})

	statusReq := &richterv1.UpdateOrganizationStatusRequest{Id: orgID, Status: richterv1.OrganizationStatus_ORGANIZATION_STATUS_ACTIVE}

	t.Run("UpdateOrganizationStatus", func(t *testing.T) {
		t.Run("Anon/Unauthenticated", func(t *testing.T) {
			assertCode(t, func() error { _, e := anonOrgs.UpdateOrganizationStatus(ctx, statusReq); return e }(), connect.CodeUnauthenticated)
		})
		t.Run("Student/PermissionDenied", func(t *testing.T) {
			assertCode(t, func() error { _, e := studentOrgs.UpdateOrganizationStatus(ctx, statusReq); return e }(), connect.CodePermissionDenied)
		})
		t.Run("OrgAdmin/PermissionDenied", func(t *testing.T) {
			assertCode(t, func() error { _, e := orgAdminOrgs.UpdateOrganizationStatus(ctx, statusReq); return e }(), connect.CodePermissionDenied)
		})
		t.Run("OrgOwner/OK", func(t *testing.T) {
			if _, err := ownerOrgs.UpdateOrganizationStatus(ctx, statusReq); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
	})

	t.Run("DeleteOrganization", func(t *testing.T) {
		// create a disposable org for delete tests
		dispSlug := testSlug()
		dispRes, err := ownerOrgs.CreateOrganization(ctx, &richterv1.CreateOrganizationRequest{
			CreatedBy: ownerID, Name: "Disposable", Slug: dispSlug,
		})
		if err != nil {
			t.Fatalf("setup: create disposable org: %v", err)
		}
		dispID := dispRes.Organization.Id

		deleteReq := &richterv1.DeleteOrganizationRequest{Id: dispID}
		t.Run("Anon/Unauthenticated", func(t *testing.T) {
			assertCode(t, func() error { _, e := anonOrgs.DeleteOrganization(ctx, deleteReq); return e }(), connect.CodeUnauthenticated)
		})
		t.Run("Student/PermissionDenied", func(t *testing.T) {
			assertCode(t, func() error { _, e := studentOrgs.DeleteOrganization(ctx, deleteReq); return e }(), connect.CodePermissionDenied)
		})
		t.Run("OrgOwner/OK", func(t *testing.T) {
			if _, err := ownerOrgs.DeleteOrganization(ctx, deleteReq); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
	})
}
