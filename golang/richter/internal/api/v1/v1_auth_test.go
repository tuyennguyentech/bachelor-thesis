//go:build integ

package v1

import (
	"net/http"
	"testing"

	"connectrpc.com/connect"
	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/buf/gen/richter/v1/richterv1connect"
	"github.com/brianvoe/gofakeit/v7"
)

type authTestClients struct {
	auth  richterv1connect.AuthServiceClient
	users richterv1connect.UserServiceClient
}

func setupAuthTestClients(t *testing.T) authTestClients {
	t.Helper()
	url := newV1Server(t)
	adminToken := getAdminToken(t, url)
	return authTestClients{
		auth:  richterv1connect.NewAuthServiceClient(http.DefaultClient, url),
		users: richterv1connect.NewUserServiceClient(httpClientWithToken(adminToken), url),
	}
}

func TestAuthValidation(t *testing.T) {
	t.Parallel()
	c := setupAuthTestClients(t)
	ctx := t.Context()

	t.Run("Login", func(t *testing.T) {
		tests := []struct {
			name string
			req  *richterv1.LoginRequest
		}{
			{
				name: "InvalidEmail",
				req: &richterv1.LoginRequest{
					Email:    "not-an-email",
					Password: gofakeit.Password(true, true, true, true, false, 12),
				},
			},
			{
				name: "ShortPassword",
				req: &richterv1.LoginRequest{
					Email:    testEmail(),
					Password: gofakeit.Password(true, true, true, true, false, 6),
				},
			},
		}
		for _, tt := range tests {
			t.Run(tt.name, func(t *testing.T) {
				_, err := c.auth.Login(ctx, tt.req)
				if err == nil {
					t.Error("expected error, got nil")
				} else if connect.CodeOf(err) != connect.CodeInvalidArgument {
					t.Errorf("expected code %v, got %v", connect.CodeInvalidArgument, connect.CodeOf(err))
				}
			})
		}
	})

	t.Run("RefreshToken", func(t *testing.T) {
		_, err := c.auth.RefreshToken(ctx, &richterv1.RefreshTokenRequest{
			RefreshToken: "",
		})
		if err == nil {
			t.Error("expected error, got nil")
		} else if connect.CodeOf(err) != connect.CodeInvalidArgument {
			t.Errorf("expected code %v, got %v", connect.CodeInvalidArgument, connect.CodeOf(err))
		}
	})

	t.Run("Logout", func(t *testing.T) {
		_, err := c.auth.Logout(ctx, &richterv1.LogoutRequest{
			RefreshToken: "",
		})
		if err == nil {
			t.Error("expected error, got nil")
		} else if connect.CodeOf(err) != connect.CodeInvalidArgument {
			t.Errorf("expected code %v, got %v", connect.CodeInvalidArgument, connect.CodeOf(err))
		}
	})
}

func TestAuthLifecycle(t *testing.T) {
	t.Parallel()
	c := setupAuthTestClients(t)
	ctx := t.Context()

	email := testEmail()
	password := gofakeit.Password(true, true, true, true, false, 12)

	createRes, err := c.users.CreateUserWithRoleAndStatus(ctx, &richterv1.CreateUserWithRoleAndStatusRequest{
		Email:     email,
		Password:  password,
		FirstName: gofakeit.FirstName(),
		LastName:  gofakeit.LastName(),
		Role:      richterv1.UserRole_USER_ROLE_NORMAL,
		Status:    richterv1.UserStatus_USER_STATUS_ACTIVE,
	})
	if err != nil {
		t.Fatalf("setup: failed to create user: %v", err)
	}
	userID := createRes.User.Id

	var refreshToken string

	t.Run("Login", func(t *testing.T) {
		res, err := c.auth.Login(ctx, &richterv1.LoginRequest{
			Email:    email,
			Password: password,
		})
		if err != nil {
			t.Fatalf("failed to login: %v", err)
		}
		if res.AccessToken == "" {
			t.Error("expected access token, got empty string")
		}
		if res.RefreshToken == "" {
			t.Error("expected refresh token, got empty string")
		}
		if res.ExpiresIn <= 0 {
			t.Errorf("expected positive expires_in, got %d", res.ExpiresIn)
		}
		if res.User.Id != userID {
			t.Errorf("expected user id %s, got %s", userID, res.User.Id)
		}
		refreshToken = res.RefreshToken
	})

	t.Run("RefreshToken", func(t *testing.T) {
		res, err := c.auth.RefreshToken(ctx, &richterv1.RefreshTokenRequest{
			RefreshToken: refreshToken,
		})
		if err != nil {
			t.Fatalf("failed to refresh token: %v", err)
		}
		if res.AccessToken == "" {
			t.Error("expected new access token, got empty string")
		}
		if res.RefreshToken == "" {
			t.Error("expected new refresh token, got empty string")
		}
		if res.RefreshToken == refreshToken {
			t.Error("expected refresh token to be rotated")
		}
		refreshToken = res.RefreshToken
	})

	t.Run("Logout", func(t *testing.T) {
		_, err := c.auth.Logout(ctx, &richterv1.LogoutRequest{
			RefreshToken: refreshToken,
		})
		if err != nil {
			t.Fatalf("failed to logout: %v", err)
		}
	})
}

func TestAuthLoginErrors(t *testing.T) {
	t.Parallel()
	c := setupAuthTestClients(t)
	ctx := t.Context()

	email := testEmail()
	password := gofakeit.Password(true, true, true, true, false, 12)

	_, err := c.users.CreateUserWithRoleAndStatus(ctx, &richterv1.CreateUserWithRoleAndStatusRequest{
		Email:     email,
		Password:  password,
		FirstName: gofakeit.FirstName(),
		LastName:  gofakeit.LastName(),
		Role:      richterv1.UserRole_USER_ROLE_NORMAL,
		Status:    richterv1.UserStatus_USER_STATUS_ACTIVE,
	})
	if err != nil {
		t.Fatalf("setup: failed to create user: %v", err)
	}

	t.Run("WrongPassword", func(t *testing.T) {
		_, err := c.auth.Login(ctx, &richterv1.LoginRequest{
			Email:    email,
			Password: gofakeit.Password(true, true, true, true, false, 12),
		})
		if err == nil {
			t.Error("expected error for wrong password, got nil")
		} else if connect.CodeOf(err) != connect.CodeUnauthenticated {
			t.Errorf("expected code %v, got %v", connect.CodeUnauthenticated, connect.CodeOf(err))
		}
	})

	t.Run("UserNotFound", func(t *testing.T) {
		_, err := c.auth.Login(ctx, &richterv1.LoginRequest{
			Email:    testEmail(),
			Password: gofakeit.Password(true, true, true, true, false, 12),
		})
		if err == nil {
			t.Error("expected error for non-existent user, got nil")
		} else if connect.CodeOf(err) != connect.CodeUnauthenticated {
			t.Errorf("expected code %v, got %v", connect.CodeUnauthenticated, connect.CodeOf(err))
		}
	})

	t.Run("InactiveUser", func(t *testing.T) {
		inactiveEmail := testEmail()
		inactivePassword := gofakeit.Password(true, true, true, true, false, 12)
		_, err := c.users.CreateUserWithRoleAndStatus(ctx, &richterv1.CreateUserWithRoleAndStatusRequest{
			Email:     inactiveEmail,
			Password:  inactivePassword,
			FirstName: gofakeit.FirstName(),
			LastName:  gofakeit.LastName(),
			Role:      richterv1.UserRole_USER_ROLE_NORMAL,
			Status:    richterv1.UserStatus_USER_STATUS_PENDING,
		})
		if err != nil {
			t.Fatalf("setup: failed to create inactive user: %v", err)
		}

		// Correct password but inactive account → PermissionDenied
		_, err = c.auth.Login(ctx, &richterv1.LoginRequest{
			Email:    inactiveEmail,
			Password: inactivePassword,
		})
		if err == nil {
			t.Error("expected error for inactive user, got nil")
		} else if connect.CodeOf(err) != connect.CodePermissionDenied {
			t.Errorf("expected code %v, got %v", connect.CodePermissionDenied, connect.CodeOf(err))
		}

		// Wrong password + inactive account → also PermissionDenied (status checked before bcrypt)
		_, err = c.auth.Login(ctx, &richterv1.LoginRequest{
			Email:    inactiveEmail,
			Password: "wrongpasswordXYZ123!",
		})
		if err == nil {
			t.Error("expected error for inactive user with wrong password, got nil")
		} else if connect.CodeOf(err) != connect.CodePermissionDenied {
			t.Errorf("expected code %v, got %v", connect.CodePermissionDenied, connect.CodeOf(err))
		}
	})
}

func TestAuthLogoutErrors(t *testing.T) {
	t.Parallel()
	c := setupAuthTestClients(t)
	ctx := t.Context()

	t.Run("InvalidToken", func(t *testing.T) {
		_, err := c.auth.Logout(ctx, &richterv1.LogoutRequest{
			RefreshToken: "not.a.valid.jwt",
		})
		if err == nil {
			t.Error("expected error for invalid token, got nil")
		} else if connect.CodeOf(err) != connect.CodeUnauthenticated {
			t.Errorf("expected code %v, got %v", connect.CodeUnauthenticated, connect.CodeOf(err))
		}
	})

	t.Run("AccessTokenAsRefreshToken", func(t *testing.T) {
		email := testEmail()
		password := gofakeit.Password(true, true, true, true, false, 12)
		_, err := c.users.CreateUserWithRoleAndStatus(ctx, &richterv1.CreateUserWithRoleAndStatusRequest{
			Email:     email,
			Password:  password,
			FirstName: gofakeit.FirstName(),
			LastName:  gofakeit.LastName(),
			Role:      richterv1.UserRole_USER_ROLE_NORMAL,
			Status:    richterv1.UserStatus_USER_STATUS_ACTIVE,
		})
		if err != nil {
			t.Fatalf("setup: failed to create user: %v", err)
		}
		loginRes, err := c.auth.Login(ctx, &richterv1.LoginRequest{
			Email:    email,
			Password: password,
		})
		if err != nil {
			t.Fatalf("setup: failed to login: %v", err)
		}

		_, err = c.auth.Logout(ctx, &richterv1.LogoutRequest{
			RefreshToken: loginRes.AccessToken,
		})
		if err == nil {
			t.Error("expected error when using access token as refresh token, got nil")
		} else if connect.CodeOf(err) != connect.CodeUnauthenticated {
			t.Errorf("expected code %v, got %v", connect.CodeUnauthenticated, connect.CodeOf(err))
		}
	})
}

func TestAuthRefreshTokenErrors(t *testing.T) {
	t.Parallel()
	c := setupAuthTestClients(t)
	ctx := t.Context()

	t.Run("InvalidToken", func(t *testing.T) {
		_, err := c.auth.RefreshToken(ctx, &richterv1.RefreshTokenRequest{
			RefreshToken: "not.a.valid.jwt",
		})
		if err == nil {
			t.Error("expected error for invalid token, got nil")
		} else if connect.CodeOf(err) != connect.CodeUnauthenticated {
			t.Errorf("expected code %v, got %v", connect.CodeUnauthenticated, connect.CodeOf(err))
		}
	})

	t.Run("AccessTokenAsRefreshToken", func(t *testing.T) {
		email := testEmail()
		password := gofakeit.Password(true, true, true, true, false, 12)
		_, err := c.users.CreateUserWithRoleAndStatus(ctx, &richterv1.CreateUserWithRoleAndStatusRequest{
			Email:     email,
			Password:  password,
			FirstName: gofakeit.FirstName(),
			LastName:  gofakeit.LastName(),
			Role:      richterv1.UserRole_USER_ROLE_NORMAL,
			Status:    richterv1.UserStatus_USER_STATUS_ACTIVE,
		})
		if err != nil {
			t.Fatalf("setup: failed to create user: %v", err)
		}
		loginRes, err := c.auth.Login(ctx, &richterv1.LoginRequest{
			Email:    email,
			Password: password,
		})
		if err != nil {
			t.Fatalf("setup: failed to login: %v", err)
		}

		_, err = c.auth.RefreshToken(ctx, &richterv1.RefreshTokenRequest{
			RefreshToken: loginRes.AccessToken,
		})
		if err == nil {
			t.Error("expected error when using access token as refresh token, got nil")
		} else if connect.CodeOf(err) != connect.CodeUnauthenticated {
			t.Errorf("expected code %v, got %v", connect.CodeUnauthenticated, connect.CodeOf(err))
		}
	})

	t.Run("DisabledUserRefresh", func(t *testing.T) {
		email := testEmail()
		password := gofakeit.Password(true, true, true, true, false, 12)

		createRes, err := c.users.CreateUserWithRoleAndStatus(ctx, &richterv1.CreateUserWithRoleAndStatusRequest{
			Email:     email,
			Password:  password,
			FirstName: gofakeit.FirstName(),
			LastName:  gofakeit.LastName(),
			Role:      richterv1.UserRole_USER_ROLE_NORMAL,
			Status:    richterv1.UserStatus_USER_STATUS_ACTIVE,
		})
		if err != nil {
			t.Fatalf("setup: failed to create user: %v", err)
		}

		loginRes, err := c.auth.Login(ctx, &richterv1.LoginRequest{
			Email:    email,
			Password: password,
		})
		if err != nil {
			t.Fatalf("setup: failed to login: %v", err)
		}

		_, err = c.users.UpdateUserStatus(ctx, &richterv1.UpdateUserStatusRequest{
			Id:     createRes.User.Id,
			Status: richterv1.UserStatus_USER_STATUS_DISABLED,
		})
		if err != nil {
			t.Fatalf("setup: failed to disable user: %v", err)
		}

		_, err = c.auth.RefreshToken(ctx, &richterv1.RefreshTokenRequest{
			RefreshToken: loginRes.RefreshToken,
		})
		if err == nil {
			t.Error("expected error for disabled user refresh, got nil")
		} else if connect.CodeOf(err) != connect.CodePermissionDenied {
			t.Errorf("expected code %v, got %v", connect.CodePermissionDenied, connect.CodeOf(err))
		}
	})
}
