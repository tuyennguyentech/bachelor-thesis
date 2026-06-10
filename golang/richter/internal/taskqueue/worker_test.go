package taskqueue

import (
	"testing"

	"github.com/google/uuid"
)

func TestUUIDBytes(t *testing.T) {
	u := uuid.New()
	s := u.String()
	b := uuidBytes(s)
	got := uuid.UUID(b)
	if got != u {
		t.Errorf("uuidBytes(%q) = %v, want %v", s, got, u)
	}
}

func TestUUIDBytesPanicsOnInvalid(t *testing.T) {
	defer func() {
		if r := recover(); r == nil {
			t.Error("expected panic on invalid UUID string")
		}
	}()
	uuidBytes("not-a-uuid")
}
