//go:build unit

package secure

import (
	"testing"
	"time"

	jwtv1 "example.com/buf/gen/richter/jwt/v1"
	v1 "example.com/buf/gen/richter/v1"
	"example.com/richter/internal"
	"github.com/brianvoe/gofakeit/v7"
	"github.com/golang-jwt/jwt/v5"
	"github.com/samber/do/v2"
)

func setupJWTService(t *testing.T) *JWTService {
	t.Helper()
	return do.MustInvoke[*JWTService](internal.Injector)
}

func createTestUser() *v1.User {
	middleName := gofakeit.FirstName()
	return &v1.User{
		Id:         gofakeit.UUID(),
		Email:      gofakeit.Email(),
		FirstName:  gofakeit.FirstName(),
		MiddleName: &middleName,
		LastName:   gofakeit.LastName(),
		Role:       v1.UserRole_USER_ROLE_ADMIN,
		Status:     v1.UserStatus_USER_STATUS_ACTIVE,
	}
}

func TestGenerateAndValidateToken(t *testing.T) {
	svc := setupJWTService(t)
	user := createTestUser()

	token, err := svc.GenerateToken(user, 1*time.Hour, jwtv1.TokenType_TOKEN_TYPE_ACCESS)
	if err != nil {
		t.Fatalf("failed to generate token: %v", err)
	}
	if token == "" {
		t.Error("expected non-empty token")
	}

	claims, err := svc.ValidateToken(token)
	if err != nil {
		t.Fatalf("failed to validate token: %v", err)
	}

	if claims.Sub != user.Id {
		t.Errorf("expected sub %s, got %s", user.Id, claims.Sub)
	}
	if claims.Email != user.Email {
		t.Errorf("expected email %s, got %s", user.Email, claims.Email)
	}
	if claims.Role != user.Role {
		t.Errorf("expected role %v, got %v", user.Role, claims.Role)
	}
	if claims.FirstName != user.FirstName {
		t.Errorf("expected firstName %s, got %s", user.FirstName, claims.FirstName)
	}
	if claims.LastName != user.LastName {
		t.Errorf("expected lastName %s, got %s", user.LastName, claims.LastName)
	}
	if claims.Status != user.Status {
		t.Errorf("expected status %v, got %v", user.Status, claims.Status)
	}
	if claims.MiddleName == nil || *claims.MiddleName != *user.MiddleName {
		t.Errorf("expected middleName %s, got %v", *user.MiddleName, claims.MiddleName)
	}
	if claims.TokenType != jwtv1.TokenType_TOKEN_TYPE_ACCESS {
		t.Errorf("expected token type %v, got %v", jwtv1.TokenType_TOKEN_TYPE_ACCESS, claims.TokenType)
	}
}

func TestValidateToken_InvalidSignature(t *testing.T) {
	svc := setupJWTService(t)
	user := createTestUser()

	// Manually create a token signed with a different secret
	claims := &JWTClaims{
		JWTClaims: &jwtv1.JWTClaims{
			Sub:  user.Id,
			Iss:  issuer,
			Aud:  audience,
			Iat:  time.Now().Unix(),
			Exp:  time.Now().Add(time.Hour).Unix(),
			Role: user.Role,
		},
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	invalidToken, _ := token.SignedString([]byte("wrong-secret"))

	_, err := svc.ValidateToken(invalidToken)
	if err == nil {
		t.Error("expected error for invalid signature, got nil")
	}
}

func TestValidateToken_Expired(t *testing.T) {
	svc := setupJWTService(t)
	user := createTestUser()

	token, err := svc.GenerateToken(user, -1*time.Hour, jwtv1.TokenType_TOKEN_TYPE_ACCESS)
	if err != nil {
		t.Fatalf("failed to generate token: %v", err)
	}

	_, err = svc.ValidateToken(token)
	if err == nil {
		t.Error("expected error for expired token, got nil")
	}
}

func TestGenerateToken_WithoutMiddleName(t *testing.T) {
	svc := setupJWTService(t)
	user := &v1.User{
		Id:        gofakeit.UUID(),
		Email:     gofakeit.Email(),
		FirstName: gofakeit.FirstName(),
		LastName:  gofakeit.LastName(),
		Role:      v1.UserRole_USER_ROLE_NORMAL,
		Status:    v1.UserStatus_USER_STATUS_PENDING,
	}

	token, err := svc.GenerateToken(user, 1*time.Hour, jwtv1.TokenType_TOKEN_TYPE_ACCESS)
	if err != nil {
		t.Fatalf("failed to generate token: %v", err)
	}

	claims, err := svc.ValidateToken(token)
	if err != nil {
		t.Fatalf("failed to validate token: %v", err)
	}

	if claims.MiddleName != nil {
		t.Errorf("expected no middleName, got %v", *claims.MiddleName)
	}
}

func TestGenerateToken_TokenTypePreserved(t *testing.T) {
	svc := setupJWTService(t)
	user := createTestUser()

	for _, tt := range []struct {
		name      string
		tokenType jwtv1.TokenType
	}{
		{"Access", jwtv1.TokenType_TOKEN_TYPE_ACCESS},
		{"Refresh", jwtv1.TokenType_TOKEN_TYPE_REFRESH},
	} {
		t.Run(tt.name, func(t *testing.T) {
			token, err := svc.GenerateToken(user, 1*time.Hour, tt.tokenType)
			if err != nil {
				t.Fatalf("failed to generate token: %v", err)
			}
			claims, err := svc.ValidateToken(token)
			if err != nil {
				t.Fatalf("failed to validate token: %v", err)
			}
			if claims.TokenType != tt.tokenType {
				t.Errorf("expected token type %v, got %v", tt.tokenType, claims.TokenType)
			}
		})
	}
}

func TestJWTClaims_ImplementsJWTClaims(t *testing.T) {
	claims := &JWTClaims{
		JWTClaims: &jwtv1.JWTClaims{
			Sub: gofakeit.UUID(),
			Iss: issuer,
			Exp: time.Now().Add(1 * time.Hour).Unix(),
			Iat: time.Now().Unix(),
		},
	}

	// Verify it implements jwt.Claims
	var _ jwt.Claims = claims
	_ = claims
}
