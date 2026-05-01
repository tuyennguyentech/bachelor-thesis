package secure

import (
	"fmt"
	"time"

	jwtv1 "example.com/buf/gen/richter/jwt/v1"
	v1 "example.com/buf/gen/richter/v1"
	"example.com/richter/cfg"
	"example.com/richter/internal"
	"github.com/golang-jwt/jwt/v5"
	"github.com/samber/do/v2"
)

var Package = do.Package(
	do.Lazy(NewJWTService),
)

type JWTService struct {
	secret []byte
	leeway time.Duration
}

func NewJWTService(i do.Injector) (*JWTService, error) {
	jwtCfg, err := do.Invoke[*cfg.JwtCfg](i)
	if err != nil {
		return nil, fmt.Errorf("JwtCfg cannot be invoked: %w", err)
	}

	if jwtCfg.Secret == "" {
		return nil, fmt.Errorf("jwt secret is empty")
	}

	return &JWTService{secret: []byte(jwtCfg.Secret), leeway: jwtCfg.Leeway}, nil
}

func init() {
	Package(internal.Injector)
}

const (
	issuer   = "dyadia"
	audience = "dyadia-client"
)

// JWTClaims wraps the protobuf JWTClaims to implement jwt.Claims interface
type JWTClaims struct {
	*jwtv1.JWTClaims
}

// Implement jwt.Claims interface
func (c *JWTClaims) GetExpirationTime() (*jwt.NumericDate, error) {
	return jwt.NewNumericDate(time.Unix(c.Exp, 0)), nil
}

func (c *JWTClaims) GetIssuedAt() (*jwt.NumericDate, error) {
	return jwt.NewNumericDate(time.Unix(c.Iat, 0)), nil
}

func (c *JWTClaims) GetNotBefore() (*jwt.NumericDate, error) {
	return jwt.NewNumericDate(time.Unix(c.Nbf, 0)), nil
}

func (c *JWTClaims) GetIssuer() (string, error) {
	return c.Iss, nil
}

func (c *JWTClaims) GetSubject() (string, error) {
	return c.Sub, nil
}

func (c *JWTClaims) GetAudience() (jwt.ClaimStrings, error) {
	return jwt.ClaimStrings{c.Aud}, nil
}

func (s *JWTService) GenerateToken(user *v1.User, duration time.Duration) (string, error) {
	now := time.Now()
	claims := &JWTClaims{
		JWTClaims: &jwtv1.JWTClaims{
			Sub:       user.Id,
			Iss:       issuer,
			Aud:       audience,
			Iat:       now.Unix(),
			Exp:       now.Add(duration).Unix(),
			Nbf:       now.Unix(),
			Jti:       fmt.Sprintf("%s-%d", user.Id, now.Unix()),
			Email:     user.Email,
			Role:      user.Role,
			FirstName: user.FirstName,
			LastName:  user.LastName,
			Status:    user.Status,
		},
	}
	if user.MiddleName != nil {
		claims.MiddleName = user.MiddleName
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	tokenString, err := token.SignedString(s.secret)
	if err != nil {
		return "", fmt.Errorf("failed to sign token: %w", err)
	}
	return tokenString, nil
}

func (s *JWTService) ValidateToken(tokenString string) (*jwtv1.JWTClaims, error) {
	token, err := jwt.ParseWithClaims(
		tokenString,
		&JWTClaims{},
		func(token *jwt.Token) (any, error) {
			if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
				return nil, fmt.Errorf("unexpected signing method: %v", token.Header["alg"])
			}
			return s.secret, nil
		},
		jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}),
		jwt.WithLeeway(s.leeway),
	)
	if err != nil {
		return nil, fmt.Errorf("failed to parse token: %w", err)
	}

	claims, ok := token.Claims.(*JWTClaims)
	if !ok || !token.Valid {
		return nil, fmt.Errorf("invalid token")
	}

	return claims.JWTClaims, nil
}
