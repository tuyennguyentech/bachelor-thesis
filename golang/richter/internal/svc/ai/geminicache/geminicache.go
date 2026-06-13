// Package geminicache is an on-disk response cache for Gemini generation
// calls. It exists to make the AI test suite quota-independent: the structured
// generation pipeline (chunking + item generation) hits Gemini's free-tier
// per-minute / per-day quota under parallel test load, which turns otherwise
// deterministic tests into flaky ones. With a warmed cache, a run replays the
// recorded responses from disk and never touches the network, so the suite is
// both deterministic and free.
//
// The cache is keyed by sha256(model + prompt): the same model and the same
// fully-rendered prompt always map to the same response file. Because the test
// fixtures (seed videos → transcripts → prompts) are deterministic, a cassette
// recorded once stays valid until the model name or a prompt template changes —
// at which point the key changes and the stale entry is simply never read
// again (a miss falls back to a live call), so there is no invalidation step.
//
// A nil *Cache is a fully valid disabled cache: every method is a safe no-op
// miss. New("") returns nil, so production (which never sets a cache dir) pays
// nothing and call sites need no special-casing.
package geminicache

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
)

// Cache replays/records Gemini responses under a directory. The zero value is
// not usable; construct with New. A nil *Cache is the disabled cache.
type Cache struct {
	dir string
}

// New returns a cache rooted at dir, or nil (disabled) when dir is empty.
func New(dir string) *Cache {
	if dir == "" {
		return nil
	}
	return &Cache{dir: dir}
}

// Enabled reports whether the cache will read/write (false for a nil cache).
func (c *Cache) Enabled() bool { return c != nil }

func (c *Cache) path(model, prompt string) string {
	h := sha256.Sum256([]byte(model + "\x00" + prompt))
	return filepath.Join(c.dir, hex.EncodeToString(h[:])+".json")
}

// Get returns the recorded response and true on a hit. A nil cache, a missing
// file, or any read error is a miss — the caller should then make a live call.
func (c *Cache) Get(model, prompt string) (string, bool) {
	if c == nil {
		return "", false
	}
	b, err := os.ReadFile(c.path(model, prompt))
	if err != nil {
		return "", false
	}
	return string(b), true
}

// Put records a successful, non-empty response. A nil cache or empty text is a
// no-op, so a throttled/failed call (which yields no text) can never poison the
// cache. Write is atomic (temp file + rename); any I/O error is swallowed
// because the cache is an optimization, never a hard dependency of the call.
func (c *Cache) Put(model, prompt, text string) {
	if c == nil || text == "" {
		return
	}
	if err := os.MkdirAll(c.dir, 0o755); err != nil {
		return
	}
	final := c.path(model, prompt)
	tmp := final + ".tmp"
	if err := os.WriteFile(tmp, []byte(text), 0o644); err != nil {
		return
	}
	_ = os.Rename(tmp, final)
}
