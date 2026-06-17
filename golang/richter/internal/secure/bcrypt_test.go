package secure

import (
	"errors"
	"strings"
	"testing"
)

func TestHashAndVerifyPassword_RoundTrip(t *testing.T) {
	t.Parallel()
	const pw = "correct horse battery"
	hash, err := HashPassword(pw)
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	if hash == pw {
		t.Fatal("hash must not equal the plaintext password")
	}
	if !VerifyPassword(pw, hash) {
		t.Fatal("VerifyPassword must accept the correct password")
	}
	if VerifyPassword("wrong password", hash) {
		t.Fatal("VerifyPassword must reject an incorrect password")
	}
}

func TestHashPassword_SaltedSoHashesDiffer(t *testing.T) {
	t.Parallel()
	const pw = "same-password"
	h1, err := HashPassword(pw)
	if err != nil {
		t.Fatalf("HashPassword #1: %v", err)
	}
	h2, err := HashPassword(pw)
	if err != nil {
		t.Fatalf("HashPassword #2: %v", err)
	}
	if h1 == h2 {
		t.Fatal("bcrypt must salt: two hashes of the same password must differ")
	}
	// Both independently-salted hashes must still verify.
	if !VerifyPassword(pw, h1) || !VerifyPassword(pw, h2) {
		t.Fatal("both salted hashes must verify against the original password")
	}
}

func TestHashPassword_LengthBoundary(t *testing.T) {
	t.Parallel()
	// Exactly 72 bytes is the last accepted length.
	atLimit := strings.Repeat("a", maxPasswordBytes)
	if _, err := HashPassword(atLimit); err != nil {
		t.Fatalf("HashPassword at %d bytes must succeed, got %v", maxPasswordBytes, err)
	}
	// 73 bytes must be rejected rather than silently truncated by bcrypt — a
	// silent truncation would let "a"*72 and "a"*73 share a hash, weakening auth.
	tooLong := strings.Repeat("a", maxPasswordBytes+1)
	if _, err := HashPassword(tooLong); !errors.Is(err, ErrPasswordTooLong) {
		t.Fatalf("HashPassword over the limit must return ErrPasswordTooLong, got %v", err)
	}
}

func TestVerifyPassword_RejectsOverLongAndGarbageHash(t *testing.T) {
	t.Parallel()
	hash, err := HashPassword(strings.Repeat("a", maxPasswordBytes))
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	// An over-long candidate must be rejected up front (mirrors the HashPassword
	// guard) so the truncation can't be used to bypass the limit at verify time.
	if VerifyPassword(strings.Repeat("a", maxPasswordBytes+1), hash) {
		t.Fatal("VerifyPassword must reject candidates longer than the limit")
	}
	// A non-bcrypt hash string must not verify (and must not panic).
	if VerifyPassword("whatever", "not-a-bcrypt-hash") {
		t.Fatal("VerifyPassword must return false for a malformed hash")
	}
}
