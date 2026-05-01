//go:build integ

package v1

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"connectrpc.com/connect"
	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/buf/gen/richter/v1/richterv1connect"
	"example.com/richter/internal"
	"github.com/brianvoe/gofakeit/v7"
	"github.com/samber/do/v2"
)

func setupTestClient(t *testing.T) richterv1connect.UserServiceClient {
	t.Helper()
	v1, err := do.Invoke[*V1Svc](internal.Injector)
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(v1.Mux)
	t.Cleanup(func() { ts.Close() })
	return richterv1connect.NewUserServiceClient(http.DefaultClient, ts.URL)
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
				Email:     gofakeit.Email(),
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
	email := gofakeit.Email()
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

	email := gofakeit.Email()
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
