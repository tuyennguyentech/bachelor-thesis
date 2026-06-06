package ai

import "sync"

// analysisLocks guards ExtractTranscriptStream against concurrent re-runs for
// the same lesson. It deletes idle entries after release so a long-lived server
// does not retain one lock per historical lesson ID forever.
//
// The lock is per-process. For multi-instance deployments, replace this with a
// FDB-based lease with TTL.
var analysisLocks = newAnalysisLockRegistry()

type analysisLockEntry struct {
	mu   sync.Mutex
	refs int
}

type analysisLockRegistry struct {
	mu    sync.Mutex
	locks map[string]*analysisLockEntry
}

func newAnalysisLockRegistry() *analysisLockRegistry {
	return &analysisLockRegistry{locks: make(map[string]*analysisLockEntry)}
}

func (r *analysisLockRegistry) tryAcquire(key string) (*analysisLockEntry, bool) {
	r.mu.Lock()
	entry := r.locks[key]
	if entry == nil {
		entry = &analysisLockEntry{}
		r.locks[key] = entry
	}
	entry.refs++
	r.mu.Unlock()

	if !entry.mu.TryLock() {
		r.releaseRef(key, entry)
		return nil, false
	}
	return entry, true
}

func (r *analysisLockRegistry) release(key string, entry *analysisLockEntry) {
	entry.mu.Unlock()
	r.releaseRef(key, entry)
}

func (r *analysisLockRegistry) releaseRef(key string, entry *analysisLockEntry) {
	r.mu.Lock()
	defer r.mu.Unlock()
	entry.refs--
	if entry.refs == 0 && r.locks[key] == entry {
		delete(r.locks, key)
	}
}

func (r *analysisLockRegistry) len() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.locks)
}
