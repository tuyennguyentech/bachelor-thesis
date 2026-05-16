package secure

import (
	"errors"
	"fmt"

	"golang.org/x/crypto/bcrypt"
)

// maxPasswordBytes is bcrypt's hard input limit. Passwords longer than this
// are silently truncated by bcrypt, which would allow trivially bypassing
// authentication and opens a DoS vector (hashing a 1 MB string is expensive).
const maxPasswordBytes = 72

var ErrPasswordTooLong = errors.New("password must not exceed 72 characters")

func HashPassword(password string) (string, error) {
	if len(password) > maxPasswordBytes {
		return "", ErrPasswordTooLong
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return "", fmt.Errorf("hash password: %w", err)
	}
	return string(hash), nil
}

func VerifyPassword(password, passwordHash string) bool {
	if len(password) > maxPasswordBytes {
		return false
	}
	return bcrypt.CompareHashAndPassword([]byte(passwordHash), []byte(password)) == nil
}
