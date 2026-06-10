package taskqueue

import (
	"context"
	"testing"
)

func TestRegistryRegisterAndLookup(t *testing.T) {
	// Save and restore global registry after test.
	old := registry
	registry = map[string]Factory{}
	defer func() { registry = old }()

	called := false
	factory := func() Executor {
		called = true
		return &fakeExecutor{kind: "test_kind"}
	}

	Register("test_kind", factory)

	// Lookup returns the factory.
	got := Lookup("test_kind")
	if got == nil {
		t.Fatal("Lookup returned nil for registered kind")
	}
	exec := got()
	if exec.Kind() != "test_kind" {
		t.Errorf("Kind() = %q, want %q", exec.Kind(), "test_kind")
	}
	if !called {
		t.Error("factory was not called")
	}
}

func TestRegistryLookupUnknown(t *testing.T) {
	old := registry
	registry = map[string]Factory{}
	defer func() { registry = old }()

	got := Lookup("nonexistent")
	if got != nil {
		t.Errorf("Lookup returned non-nil for unknown kind: %v", got)
	}
}

func TestRegistryDuplicatePanics(t *testing.T) {
	old := registry
	registry = map[string]Factory{}
	defer func() { registry = old }()

	Register("dup", func() Executor { return &fakeExecutor{kind: "dup"} })

	defer func() {
		r := recover()
		if r == nil {
			t.Error("expected panic on duplicate registration")
		}
	}()
	Register("dup", func() Executor { return &fakeExecutor{kind: "dup"} })
}

func TestRegisteredKinds(t *testing.T) {
	old := registry
	registry = map[string]Factory{}
	defer func() { registry = old }()

	Register("a", func() Executor { return &fakeExecutor{kind: "a"} })
	Register("b", func() Executor { return &fakeExecutor{kind: "b"} })

	kinds := RegisteredKinds()
	if len(kinds) != 2 {
		t.Errorf("RegisteredKinds() returned %d kinds, want 2", len(kinds))
	}
	// Check both are present (order not guaranteed).
	m := map[string]bool{}
	for _, k := range kinds {
		m[k] = true
	}
	if !m["a"] || !m["b"] {
		t.Errorf("RegisteredKinds() = %v, want [a, b]", kinds)
	}
}

// fakeExecutor is a minimal Executor for testing.
type fakeExecutor struct {
	kind string
}

func (f *fakeExecutor) Kind() string { return f.kind }
func (f *fakeExecutor) Execute(_ context.Context, _ *Env) ([]byte, error) {
	return []byte("ok"), nil
}
