package ai

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"

	richterv1 "example.com/buf/gen/richter/v1"
)

// TestAnalysisLocks_SerializesSameLesson verifies the per-lesson analysis lock
// actually prevents two callers from running concurrently for the same lesson,
// while allowing parallel execution for different lessons.
func TestAnalysisLocks_SerializesSameLesson(t *testing.T) {
	const lessonID = "test-lesson-serial"
	analysisLocks = newAnalysisLockRegistry()
	lock, ok := analysisLocks.tryAcquire(lessonID)
	if !ok {
		t.Fatal("first TryLock must succeed on a fresh lock")
	}

	// Second TryLock on the same lesson should fail.
	if _, ok := analysisLocks.tryAcquire(lessonID); ok {
		t.Fatal("second TryLock on the same lesson must fail while first is held")
	}
	analysisLocks.release(lessonID, lock)

	// A different lesson has its own lock and is unaffected.
	const otherLessonID = "test-lesson-other"
	other, ok := analysisLocks.tryAcquire(otherLessonID)
	if !ok {
		t.Fatal("first TryLock on a different lesson must succeed")
	}
	analysisLocks.release(otherLessonID, other)
	if got := analysisLocks.len(); got != 0 {
		t.Fatalf("analysis lock registry leaked %d entries", got)
	}
}

// TestAnalysisLocks_ParallelLessonsContended is a stress test: spawn N
// goroutines that all try to lock the SAME lesson and check that at most one
// holds it at any moment.
func TestAnalysisLocks_ParallelLessonsContended(t *testing.T) {
	const lessonID = "test-lesson-contention"
	const workers = 50
	const itersPerWorker = 100

	analysisLocks = newAnalysisLockRegistry()

	var holders int32
	var peak int32
	var wg sync.WaitGroup
	wg.Add(workers)
	for i := 0; i < workers; i++ {
		go func() {
			defer wg.Done()
			for j := 0; j < itersPerWorker; j++ {
				var lock *analysisLockEntry
				for {
					var ok bool
					lock, ok = analysisLocks.tryAcquire(lessonID)
					if ok {
						break
					}
					time.Sleep(time.Microsecond)
				}
				now := atomic.AddInt32(&holders, 1)
				for {
					p := atomic.LoadInt32(&peak)
					if now <= p || atomic.CompareAndSwapInt32(&peak, p, now) {
						break
					}
				}
				if now != 1 {
					t.Errorf("lock held by %d goroutines concurrently", now)
				}
				time.Sleep(time.Microsecond)
				atomic.AddInt32(&holders, -1)
				analysisLocks.release(lessonID, lock)
			}
		}()
	}
	wg.Wait()
	if peak > 1 {
		t.Errorf("peak concurrent holders = %d, want 1", peak)
	}
	if got := analysisLocks.len(); got != 0 {
		t.Fatalf("analysis lock registry leaked %d entries", got)
	}
}

// TestInteractionGenerationBatchSize pins the per-kind batch sizes used by the
// even-distribution generator. Listening and reading are clamped to 1 because
// a single item already exhausts a meaningful fraction of the output token
// budget at 65536.
func TestInteractionGenerationBatchSize(t *testing.T) {
	cases := []struct {
		kind richterv1.InteractionKind
		want int32
	}{
		{richterv1.InteractionKind_INTERACTION_KIND_LISTENING, 1},
		{richterv1.InteractionKind_INTERACTION_KIND_READING, 1},
		{richterv1.InteractionKind_INTERACTION_KIND_SINGLE_CHOICE, 4},
		{richterv1.InteractionKind_INTERACTION_KIND_MULTIPLE_CHOICE, 4},
		{richterv1.InteractionKind_INTERACTION_KIND_FILL_BLANK, 4},
	}
	for _, c := range cases {
		t.Run(c.kind.String(), func(t *testing.T) {
			if got := interactionGenerationBatchSize(c.kind); got != c.want {
				t.Errorf("batch size for %s: want %d, got %d", c.kind, c.want, got)
			}
		})
	}
}
