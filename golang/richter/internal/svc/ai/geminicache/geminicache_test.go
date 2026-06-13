package geminicache

import (
	"os"
	"path/filepath"
	"testing"
)

func TestNilCacheIsDisabledNoOp(t *testing.T) {
	var c *Cache = New("") // empty dir => disabled
	if c != nil {
		t.Fatalf("New(\"\") = %v, want nil (disabled)", c)
	}
	if c.Enabled() {
		t.Fatal("nil cache reports Enabled() = true")
	}
	if got, ok := c.Get("model", "prompt"); ok || got != "" {
		t.Fatalf("nil cache Get = (%q, %v), want (\"\", false)", got, ok)
	}
	// Put on a nil cache must not panic and must write nothing.
	c.Put("model", "prompt", "response")
}

func TestRoundTripHitAndMiss(t *testing.T) {
	c := New(t.TempDir())
	if !c.Enabled() {
		t.Fatal("cache with a dir reports Enabled() = false")
	}

	if _, ok := c.Get("m", "p"); ok {
		t.Fatal("cold Get reported a hit")
	}

	c.Put("m", "p", `{"items":[]}`)

	got, ok := c.Get("m", "p")
	if !ok || got != `{"items":[]}` {
		t.Fatalf("warm Get = (%q, %v), want (`{\"items\":[]}`, true)", got, ok)
	}

	// A different model or prompt must miss — the key binds both.
	if _, ok := c.Get("m2", "p"); ok {
		t.Fatal("different model hit the same key")
	}
	if _, ok := c.Get("m", "p2"); ok {
		t.Fatal("different prompt hit the same key")
	}
}

func TestPutEmptyDoesNotPoison(t *testing.T) {
	dir := t.TempDir()
	c := New(dir)

	// A throttled/failed call yields no text; it must never create an entry,
	// otherwise an empty cassette would mask a real response forever.
	c.Put("m", "p", "")

	if _, ok := c.Get("m", "p"); ok {
		t.Fatal("empty Put created a cache entry")
	}
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if filepath.Ext(e.Name()) == ".json" {
			t.Fatalf("empty Put wrote a cassette file: %s", e.Name())
		}
	}
}
