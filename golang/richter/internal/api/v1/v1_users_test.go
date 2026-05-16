//go:build integ

package v1

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"connectrpc.com/connect"
	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/buf/gen/richter/v1/richterv1connect"
	"example.com/richter/cfg"
	"example.com/richter/internal"
	"github.com/brianvoe/gofakeit/v7"
	"github.com/samber/do/v2"
)

// tokenRT injects a Bearer token into every request.
type tokenRT struct{ token string }

func (t *tokenRT) RoundTrip(req *http.Request) (*http.Response, error) {
	req = req.Clone(req.Context())
	if t.token != "" {
		req.Header.Set("Authorization", "Bearer "+t.token)
	}
	return http.DefaultTransport.RoundTrip(req)
}

func httpClientWithToken(token string) *http.Client {
	return &http.Client{Transport: &tokenRT{token: token}}
}

// newV1Server starts a test HTTP server backed by the shared V1 mux and returns its URL.
func newV1Server(t *testing.T) string {
	t.Helper()
	v1, err := do.Invoke[*V1Svc](internal.Injector)
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(v1.Mux)
	t.Cleanup(ts.Close)
	return ts.URL
}

// getAdminToken logs in as the configured system admin and returns an access token.
func getAdminToken(t *testing.T, url string) string {
	t.Helper()
	adminCfg, err := do.Invoke[*cfg.AdminCfg](internal.Injector)
	if err != nil {
		t.Fatal(err)
	}
	c := richterv1connect.NewAuthServiceClient(http.DefaultClient, url)
	res, err := c.Login(context.Background(), &richterv1.LoginRequest{
		Email:    adminCfg.Email,
		Password: adminCfg.Password,
	})
	if err != nil {
		t.Fatalf("admin login: %v", err)
	}
	return res.AccessToken
}

// getUserToken logs in as the given user and returns an access token.
func getUserToken(t *testing.T, url, email, password string) string {
	t.Helper()
	c := richterv1connect.NewAuthServiceClient(http.DefaultClient, url)
	res, err := c.Login(context.Background(), &richterv1.LoginRequest{
		Email:    email,
		Password: password,
	})
	if err != nil {
		t.Fatalf("login %s: %v", email, err)
	}
	return res.AccessToken
}

// createActiveUser creates a normal active user via the admin client and returns their credentials.
func createActiveUser(t *testing.T, adminUsers richterv1connect.UserServiceClient) (email, password, userID string) {
	t.Helper()
	email = testEmail()
	password = gofakeit.Password(true, true, true, true, false, 12)
	res, err := adminUsers.CreateUserWithRoleAndStatus(context.Background(), &richterv1.CreateUserWithRoleAndStatusRequest{
		Email:     email,
		Password:  password,
		FirstName: gofakeit.FirstName(),
		LastName:  gofakeit.LastName(),
		Role:      richterv1.UserRole_USER_ROLE_NORMAL,
		Status:    richterv1.UserStatus_USER_STATUS_ACTIVE,
	})
	if err != nil {
		t.Fatalf("create active user: %v", err)
	}
	return email, password, res.User.Id
}

// testEmail returns a unique email that never collides across test runs.
// Uses gofakeit for realistic data but appends a UUID tag to the local part.
func testEmail() string {
	e := gofakeit.Email()
	at := strings.Index(e, "@")
	return e[:at] + "+" + gofakeit.UUID()[:8] + e[at:]
}

// testSlug returns a unique org slug that never collides across test runs.
// Uses gofakeit for a realistic base and appends a UUID suffix.
func testSlug() string {
	return strings.ToLower(gofakeit.Lexify("org-????-????")) + "-" + gofakeit.UUID()[:8]
}

// testPassword returns a random valid password (meets min-length + complexity rules).
func testPassword() string {
	return gofakeit.Password(true, true, true, true, false, 12)
}

// assertCode asserts that err is non-nil and carries the expected Connect code.
func assertCode(t *testing.T, err error, code connect.Code) {
	t.Helper()
	if err == nil {
		t.Errorf("expected error %v, got nil", code)
		return
	}
	if got := connect.CodeOf(err); got != code {
		t.Errorf("expected code %v, got %v", code, got)
	}
}

func setupTestClient(t *testing.T) richterv1connect.UserServiceClient {
	t.Helper()
	url := newV1Server(t)
	return richterv1connect.NewUserServiceClient(httpClientWithToken(getAdminToken(t, url)), url)
}

func TestUserValidation(t *testing.T) {
	c := setupTestClient(t)
	ctx := t.Context()

	tests := []struct {
		name    string
		req     *richterv1.CreateUserRequest
		wantErr bool
	}{
		{
			name: "InvalidEmail",
			req: &richterv1.CreateUserRequest{
				Email:     "not-an-email",
				Password:  gofakeit.Password(true, true, true, true, false, 12),
				FirstName: gofakeit.FirstName(),
				LastName:  gofakeit.LastName(),
			},
			wantErr: true,
		},
		{
			name: "ShortPassword",
			req: &richterv1.CreateUserRequest{
				Email:     testEmail(),
				Password:  gofakeit.Password(true, true, true, true, false, 6),
				FirstName: gofakeit.FirstName(),
				LastName:  gofakeit.LastName(),
			},
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := c.CreateUser(ctx, tt.req)
			if tt.wantErr {
				if err == nil {
					t.Error("expected error, got nil")
				} else if connect.CodeOf(err) != connect.CodeInvalidArgument {
					t.Errorf("expected code %v, got %v", connect.CodeInvalidArgument, connect.CodeOf(err))
				}
			} else if err != nil {
				t.Errorf("unexpected error: %v", err)
			}
		})
	}
}

func TestUserLifecycle(t *testing.T) {
	c := setupTestClient(t)
	ctx := t.Context()

	var userId string
	email := testEmail()
	password := gofakeit.Password(true, true, true, true, false, 12)
	firstName := gofakeit.FirstName()
	lastName := gofakeit.LastName()

	t.Run("CreateUser", func(t *testing.T) {
		res, err := c.CreateUser(ctx, &richterv1.CreateUserRequest{
			Email:     email,
			Password:  password,
			FirstName: firstName,
			LastName:  lastName,
		})
		if err != nil {
			t.Fatalf("failed to create user: %v", err)
		}
		if res.User.Email != email {
			t.Errorf("expected email %s, got %s", email, res.User.Email)
		}
		userId = res.User.Id
	})

	t.Run("GetUserByEmail", func(t *testing.T) {
		res, err := c.GetUserByEmail(ctx, &richterv1.GetUserByEmailRequest{
			Email: email,
		})
		if err != nil {
			t.Fatalf("failed to get user by email: %v", err)
		}
		if res.User.Id != userId {
			t.Errorf("expected id %s, got %s", userId, res.User.Id)
		}
	})

	t.Run("GetUserById", func(t *testing.T) {
		res, err := c.GetUserById(ctx, &richterv1.GetUserByIdRequest{
			Id: userId,
		})
		if err != nil {
			t.Fatalf("failed to get user by id: %v", err)
		}
		if res.User.Email != email {
			t.Errorf("expected email %s, got %s", email, res.User.Email)
		}
	})

	t.Run("UpdateUserProfile", func(t *testing.T) {
		newName := gofakeit.FirstName()
		res, err := c.UpdateUserProfile(ctx, &richterv1.UpdateUserProfileRequest{
			Id:        userId,
			FirstName: newName,
			LastName:  lastName,
		})
		if err != nil {
			t.Fatalf("failed to update user profile: %v", err)
		}
		if res.User.FirstName != newName {
			t.Errorf("expected firstName %s, got %s", newName, res.User.FirstName)
		}
	})

	t.Run("UpdateUserPassword", func(t *testing.T) {
		newPassword := gofakeit.Password(true, true, true, true, false, 12)
		res, err := c.UpdateUserPassword(ctx, &richterv1.UpdateUserPasswordRequest{
			Id:       userId,
			Password: newPassword,
		})
		if err != nil {
			t.Fatalf("failed to update password: %v", err)
		}
		if res.User.Id != userId {
			t.Errorf("expected id %s, got %s", userId, res.User.Id)
		}
	})

	t.Run("UpdateUserRole", func(t *testing.T) {
		res, err := c.UpdateUserRole(ctx, &richterv1.UpdateUserRoleRequest{
			Id:   userId,
			Role: richterv1.UserRole_USER_ROLE_ADMIN,
		})
		if err != nil {
			t.Fatalf("failed to update role: %v", err)
		}
		if res.User.Role != richterv1.UserRole_USER_ROLE_ADMIN {
			t.Errorf("expected role ADMIN, got %v", res.User.Role)
		}
	})

	t.Run("UpdateUserStatus", func(t *testing.T) {
		res, err := c.UpdateUserStatus(ctx, &richterv1.UpdateUserStatusRequest{
			Id:     userId,
			Status: richterv1.UserStatus_USER_STATUS_DISABLED,
		})
		if err != nil {
			t.Fatalf("failed to update status: %v", err)
		}
		if res.User.Status != richterv1.UserStatus_USER_STATUS_DISABLED {
			t.Errorf("expected status DISABLED, got %v", res.User.Status)
		}
	})

	t.Run("ListUsers", func(t *testing.T) {
		res, err := c.ListUsers(ctx, &richterv1.ListUsersRequest{
			Limit: 10,
		})
		if err != nil {
			t.Fatalf("failed to list users: %v", err)
		}
		if len(res.Users) == 0 {
			t.Fatal("expected at least one user in list")
		}
		found := false
		for _, u := range res.Users {
			if u.Id == userId {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("user %s not found in list", userId)
		}
	})

	t.Run("DuplicateEmailError", func(t *testing.T) {
		_, err := c.CreateUser(ctx, &richterv1.CreateUserRequest{
			Email:     email,
			Password:  gofakeit.Password(true, true, true, true, false, 12),
			FirstName: gofakeit.FirstName(),
			LastName:  gofakeit.LastName(),
		})
		if err == nil {
			t.Error("expected error for duplicate email, got nil")
		} else if connect.CodeOf(err) != connect.CodeAlreadyExists {
			t.Errorf("expected code %v, got %v", connect.CodeAlreadyExists, connect.CodeOf(err))
		}
	})

	t.Run("DeleteUser", func(t *testing.T) {
		_, err := c.DeleteUser(ctx, &richterv1.DeleteUserRequest{
			Id: userId,
		})
		if err != nil {
			t.Fatalf("failed to delete user: %v", err)
		}
	})

	t.Run("VerifyDeleted", func(t *testing.T) {
		_, err := c.GetUserById(ctx, &richterv1.GetUserByIdRequest{
			Id: userId,
		})
		if err == nil {
			t.Error("expected error getting deleted user, got nil")
		} else if connect.CodeOf(err) != connect.CodeNotFound {
			t.Errorf("expected code %v, got %v", connect.CodeNotFound, connect.CodeOf(err))
		}
	})
}

func TestCreateUserWithRoleAndStatus(t *testing.T) {
	c := setupTestClient(t)
	ctx := t.Context()

	email := testEmail()
	password := gofakeit.Password(true, true, true, true, false, 12)

	t.Run("CreateWithAdminRole", func(t *testing.T) {
		res, err := c.CreateUserWithRoleAndStatus(ctx, &richterv1.CreateUserWithRoleAndStatusRequest{
			Email:     email,
			Password:  password,
			FirstName: gofakeit.FirstName(),
			LastName:  gofakeit.LastName(),
			Role:      richterv1.UserRole_USER_ROLE_ADMIN,
			Status:    richterv1.UserStatus_USER_STATUS_ACTIVE,
		})
		if err != nil {
			t.Fatalf("failed to create user with role/status: %v", err)
		}
		if res.User.Role != richterv1.UserRole_USER_ROLE_ADMIN {
			t.Errorf("expected role ADMIN, got %v", res.User.Role)
		}
		if res.User.Status != richterv1.UserStatus_USER_STATUS_ACTIVE {
			t.Errorf("expected status ACTIVE, got %v", res.User.Status)
		}
	})

	t.Run("ValidationError", func(t *testing.T) {
		_, err := c.CreateUserWithRoleAndStatus(ctx, &richterv1.CreateUserWithRoleAndStatusRequest{
			Email:     "invalid-email",
			Password:  gofakeit.Password(true, true, true, true, false, 6),
			FirstName: gofakeit.FirstName(),
			LastName:  gofakeit.LastName(),
			Role:      richterv1.UserRole_USER_ROLE_ADMIN,
			Status:    richterv1.UserStatus_USER_STATUS_ACTIVE,
		})
		if err == nil {
			t.Error("expected validation error, got nil")
		} else if connect.CodeOf(err) != connect.CodeInvalidArgument {
			t.Errorf("expected code %v, got %v", connect.CodeInvalidArgument, connect.CodeOf(err))
		}
	})
}

func TestUsersAuthz(t *testing.T) {
	url := newV1Server(t)
	ctx := context.Background()
	adminToken := getAdminToken(t, url)

	adminUsers := richterv1connect.NewUserServiceClient(httpClientWithToken(adminToken), url)
	anonUsers := richterv1connect.NewUserServiceClient(http.DefaultClient, url)

	// target user: subject of self/other authz checks
	tEmail, tPass, tID := createActiveUser(t, adminUsers)
	selfToken := getUserToken(t, url, tEmail, tPass)
	selfUsers := richterv1connect.NewUserServiceClient(httpClientWithToken(selfToken), url)

	// other user: a different normal user (not the target)
	otherEmail, otherPass, _ := createActiveUser(t, adminUsers)
	otherToken := getUserToken(t, url, otherEmail, otherPass)
	otherUsers := richterv1connect.NewUserServiceClient(httpClientWithToken(otherToken), url)

	t.Run("RegisterUser", func(t *testing.T) {
		newEmail := testEmail()
		req := &richterv1.RegisterUserRequest{
			Email: newEmail, Password: testPassword(),
			FirstName: gofakeit.FirstName(), LastName: gofakeit.LastName(),
		}
		t.Run("Anon/OK", func(t *testing.T) {
			got, err := anonUsers.RegisterUser(ctx, req)
			if err != nil {
				t.Errorf("expected OK, got %v", err)
				return
			}
			if got.User.GetStatus() != richterv1.UserStatus_USER_STATUS_PENDING {
				t.Errorf("expected PENDING status for self-registered user, got %v", got.User.GetStatus())
			}
		})
	})

	t.Run("CreateUser", func(t *testing.T) {
		req := func() *richterv1.CreateUserRequest {
			return &richterv1.CreateUserRequest{
				Email: testEmail(), Password: testPassword(),
				FirstName: gofakeit.FirstName(), LastName: gofakeit.LastName(),
			}
		}
		t.Run("Anon/Unauthenticated", func(t *testing.T) {
			assertCode(t, func() error { _, e := anonUsers.CreateUser(ctx, req()); return e }(), connect.CodeUnauthenticated)
		})
		t.Run("User/PermissionDenied", func(t *testing.T) {
			assertCode(t, func() error { _, e := otherUsers.CreateUser(ctx, req()); return e }(), connect.CodePermissionDenied)
		})
		t.Run("Admin/OK", func(t *testing.T) {
			if _, err := adminUsers.CreateUser(ctx, req()); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
	})

	t.Run("CreateUserWithRoleAndStatus", func(t *testing.T) {
		req := func() *richterv1.CreateUserWithRoleAndStatusRequest {
			return &richterv1.CreateUserWithRoleAndStatusRequest{
				Email: testEmail(), Password: testPassword(),
				FirstName: gofakeit.FirstName(), LastName: gofakeit.LastName(),
				Role: richterv1.UserRole_USER_ROLE_NORMAL, Status: richterv1.UserStatus_USER_STATUS_ACTIVE,
			}
		}
		t.Run("Anon/Unauthenticated", func(t *testing.T) {
			assertCode(t, func() error { _, e := anonUsers.CreateUserWithRoleAndStatus(ctx, req()); return e }(), connect.CodeUnauthenticated)
		})
		t.Run("User/PermissionDenied", func(t *testing.T) {
			assertCode(t, func() error { _, e := selfUsers.CreateUserWithRoleAndStatus(ctx, req()); return e }(), connect.CodePermissionDenied)
		})
		t.Run("Admin/OK", func(t *testing.T) {
			if _, err := adminUsers.CreateUserWithRoleAndStatus(ctx, req()); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
	})

	t.Run("GetUserById", func(t *testing.T) {
		req := &richterv1.GetUserByIdRequest{Id: tID}
		t.Run("Anon/Unauthenticated", func(t *testing.T) {
			assertCode(t, func() error { _, e := anonUsers.GetUserById(ctx, req); return e }(), connect.CodeUnauthenticated)
		})
		t.Run("OtherUser/PermissionDenied", func(t *testing.T) {
			assertCode(t, func() error { _, e := otherUsers.GetUserById(ctx, req); return e }(), connect.CodePermissionDenied)
		})
		t.Run("Self/OK", func(t *testing.T) {
			if _, err := selfUsers.GetUserById(ctx, req); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
		t.Run("Admin/OK", func(t *testing.T) {
			if _, err := adminUsers.GetUserById(ctx, req); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
	})

	t.Run("GetUserByEmail", func(t *testing.T) {
		req := &richterv1.GetUserByEmailRequest{Email: tEmail}
		t.Run("Anon/Unauthenticated", func(t *testing.T) {
			assertCode(t, func() error { _, e := anonUsers.GetUserByEmail(ctx, req); return e }(), connect.CodeUnauthenticated)
		})
		t.Run("OtherUser/OK", func(t *testing.T) {
			if _, err := otherUsers.GetUserByEmail(ctx, req); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
		t.Run("Self/OK", func(t *testing.T) {
			if _, err := selfUsers.GetUserByEmail(ctx, req); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
		t.Run("Admin/OK", func(t *testing.T) {
			if _, err := adminUsers.GetUserByEmail(ctx, req); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
	})

	t.Run("ListUsers", func(t *testing.T) {
		req := &richterv1.ListUsersRequest{Limit: 10}
		t.Run("Anon/Unauthenticated", func(t *testing.T) {
			assertCode(t, func() error { _, e := anonUsers.ListUsers(ctx, req); return e }(), connect.CodeUnauthenticated)
		})
		t.Run("User/PermissionDenied", func(t *testing.T) {
			assertCode(t, func() error { _, e := selfUsers.ListUsers(ctx, req); return e }(), connect.CodePermissionDenied)
		})
		t.Run("Admin/OK", func(t *testing.T) {
			if _, err := adminUsers.ListUsers(ctx, req); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
	})

	t.Run("UpdateUserProfile", func(t *testing.T) {
		req := &richterv1.UpdateUserProfileRequest{Id: tID, FirstName: "New", LastName: "Name"}
		t.Run("Anon/Unauthenticated", func(t *testing.T) {
			assertCode(t, func() error { _, e := anonUsers.UpdateUserProfile(ctx, req); return e }(), connect.CodeUnauthenticated)
		})
		t.Run("OtherUser/PermissionDenied", func(t *testing.T) {
			assertCode(t, func() error { _, e := otherUsers.UpdateUserProfile(ctx, req); return e }(), connect.CodePermissionDenied)
		})
		t.Run("Self/OK", func(t *testing.T) {
			if _, err := selfUsers.UpdateUserProfile(ctx, req); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
		t.Run("Admin/OK", func(t *testing.T) {
			if _, err := adminUsers.UpdateUserProfile(ctx, req); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
	})

	t.Run("UpdateUserPassword", func(t *testing.T) {
		newPass := testPassword()
		req := &richterv1.UpdateUserPasswordRequest{Id: tID, Password: newPass}
		t.Run("Anon/Unauthenticated", func(t *testing.T) {
			assertCode(t, func() error { _, e := anonUsers.UpdateUserPassword(ctx, req); return e }(), connect.CodeUnauthenticated)
		})
		t.Run("OtherUser/PermissionDenied", func(t *testing.T) {
			assertCode(t, func() error { _, e := otherUsers.UpdateUserPassword(ctx, req); return e }(), connect.CodePermissionDenied)
		})
		t.Run("Self/MissingOldPassword/InvalidArgument", func(t *testing.T) {
			assertCode(t, func() error { _, e := selfUsers.UpdateUserPassword(ctx, req); return e }(), connect.CodeInvalidArgument)
		})
		t.Run("Self/OK", func(t *testing.T) {
			selfReq := &richterv1.UpdateUserPasswordRequest{Id: tID, Password: newPass, OldPassword: &tPass}
			if _, err := selfUsers.UpdateUserPassword(ctx, selfReq); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
			tPass = newPass // password has changed
		})
		t.Run("Admin/OK", func(t *testing.T) {
			if _, err := adminUsers.UpdateUserPassword(ctx, req); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
	})

	t.Run("UpdateUserRole", func(t *testing.T) {
		req := &richterv1.UpdateUserRoleRequest{Id: tID, Role: richterv1.UserRole_USER_ROLE_NORMAL}
		t.Run("Anon/Unauthenticated", func(t *testing.T) {
			assertCode(t, func() error { _, e := anonUsers.UpdateUserRole(ctx, req); return e }(), connect.CodeUnauthenticated)
		})
		t.Run("User/PermissionDenied", func(t *testing.T) {
			assertCode(t, func() error { _, e := selfUsers.UpdateUserRole(ctx, req); return e }(), connect.CodePermissionDenied)
		})
		t.Run("Admin/OK", func(t *testing.T) {
			if _, err := adminUsers.UpdateUserRole(ctx, req); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
	})

	t.Run("UpdateUserStatus", func(t *testing.T) {
		req := &richterv1.UpdateUserStatusRequest{Id: tID, Status: richterv1.UserStatus_USER_STATUS_ACTIVE}
		t.Run("Anon/Unauthenticated", func(t *testing.T) {
			assertCode(t, func() error { _, e := anonUsers.UpdateUserStatus(ctx, req); return e }(), connect.CodeUnauthenticated)
		})
		t.Run("User/PermissionDenied", func(t *testing.T) {
			assertCode(t, func() error { _, e := selfUsers.UpdateUserStatus(ctx, req); return e }(), connect.CodePermissionDenied)
		})
		t.Run("Admin/OK", func(t *testing.T) {
			if _, err := adminUsers.UpdateUserStatus(ctx, req); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
	})

	t.Run("DeleteUser", func(t *testing.T) {
		_, _, disposableID := createActiveUser(t, adminUsers)
		req := &richterv1.DeleteUserRequest{Id: disposableID}
		t.Run("Anon/Unauthenticated", func(t *testing.T) {
			assertCode(t, func() error { _, e := anonUsers.DeleteUser(ctx, req); return e }(), connect.CodeUnauthenticated)
		})
		t.Run("User/PermissionDenied", func(t *testing.T) {
			assertCode(t, func() error { _, e := selfUsers.DeleteUser(ctx, req); return e }(), connect.CodePermissionDenied)
		})
		t.Run("Admin/OK", func(t *testing.T) {
			if _, err := adminUsers.DeleteUser(ctx, req); err != nil {
				t.Errorf("expected OK, got %v", err)
			}
		})
	})
}
