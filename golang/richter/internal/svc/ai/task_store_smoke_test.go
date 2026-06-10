//go:build integ

package ai

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	richterv1 "example.com/buf/gen/richter/v1"
	"example.com/richter/internal"
	"example.com/richter/internal/kv"
	fdb "github.com/apple/foundationdb/bindings/go/src/fdb"
	"github.com/apple/foundationdb/bindings/go/src/fdb/tuple"
	"github.com/samber/do/v2"
)

// newSmokeTaskStore returns the global-injected LessonTaskStore. Tests use
// unique lesson IDs so cross-test pollution is impossible.
func newSmokeTaskStore(t *testing.T) *LessonTaskStore {
	t.Helper()
	store, err := do.Invoke[*LessonTaskStore](internal.Injector)
	if err != nil {
		t.Fatalf("LessonTaskStore: %v", err)
	}
	return store
}

func smokeCleanLesson(t *testing.T, lessonID string) {
	t.Helper()
	kvSvc, err := do.Invoke[*kv.KVSvc](internal.Injector)
	if err != nil {
		return
	}
	_, _ = kvSvc.Transact(func(tr fdb.Transaction) (any, error) {
		for _, p := range []tuple.Tuple{
			{kvNsLessonTask, "by_lesson", lessonID},
			{kvNsLessonTask, "active_target", lessonID},
		} {
			rng, e := kvSvc.RawPrefix(kvNsLessonTask, p)
			if e != nil {
				continue
			}
			tr.ClearRange(rng)
		}
		return nil, nil
	})
}

// TestTaskStoreEnqueueAndGetRoundTrip is a smoke test that doesn't drive the
// full worker pipeline — it just verifies Enqueue + Get produce a record that
// round-trips through the store correctly. Faster than running the full
// pipeline (which would need to talk to Whisper + Gemini).
func TestTaskStoreEnqueueAndGetRoundTrip(t *testing.T) {
	store := newSmokeTaskStore(t)
	tag := time.Now().UTC().Format("20060102150405.000000")
	lessonID := "smoke-enqueue-" + tag
	userID := "smoke-user-" + tag
	smokeCleanLesson(t, lessonID)
	t.Cleanup(func() { smokeCleanLesson(t, lessonID) })

	ctx := context.Background()
	rec, err := store.Enqueue(ctx, CreateLessonTaskInput{
		LessonID:  lessonID,
		Kind:      richterv1.LessonTaskKind_LESSON_TASK_KIND_EXTRACT_TRANSCRIPT,
		CreatedBy: userID,
		Message:   "smoke test",
	})
	if err != nil {
		t.Fatalf("Enqueue: %v", err)
	}
	if rec.Status != richterv1.LessonTaskStatus_LESSON_TASK_STATUS_QUEUED {
		t.Errorf("want QUEUED, got %v", rec.Status)
	}

	// Get should return the same record.
	got, err := store.Get(ctx, rec.ID)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.ID != rec.ID || got.LessonID != lessonID || got.CreatedBy != userID {
		t.Errorf("round-trip mismatch: %+v", got)
	}

	// List active should return at least one task for this lesson.
	list, err := store.List(ctx, lessonID, true, 10, 0)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	found := false
	for _, t1 := range list {
		if t1.ID == rec.ID {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("Enqueued task %s not found in List", rec.ID)
	}
}

// TestTaskStoreCancelSignalObservability ensures that a Cancel call sets the
// cancel_signal key — that's what the worker reads on every progress tick to
// honor cancellation.
func TestTaskStoreCancelSignalObservability(t *testing.T) {
	store := newSmokeTaskStore(t)
	tag := time.Now().UTC().Format("20060102150405.000000")
	lessonID := "smoke-cancel-" + tag
	userID := "smoke-cancel-user-" + tag
	smokeCleanLesson(t, lessonID)
	t.Cleanup(func() { smokeCleanLesson(t, lessonID) })

	ctx := context.Background()
	rec, err := store.Enqueue(ctx, CreateLessonTaskInput{
		LessonID:  lessonID,
		Kind:      richterv1.LessonTaskKind_LESSON_TASK_KIND_EXTRACT_TRANSCRIPT,
		CreatedBy: userID,
	})
	if err != nil {
		t.Fatalf("Enqueue: %v", err)
	}
	if _, err := store.MarkRunning(ctx, rec.ID); err != nil {
		t.Fatalf("MarkRunning: %v", err)
	}

	canceled, err := store.Cancel(ctx, rec.ID, "smoke cancel")
	if err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	if canceled.Status != richterv1.LessonTaskStatus_LESSON_TASK_STATUS_CANCELED {
		t.Errorf("want CANCELED, got %v", canceled.Status)
	}

	present, err := store.CancelSignalPresent(ctx, rec.ID)
	if err != nil {
		t.Fatalf("CancelSignalPresent: %v", err)
	}
	if !present {
		t.Error("expected cancel_signal to be set after Cancel")
	}
}

// TestTaskStoreActiveUniqueness_RejectsSecondEnqueue verifies the active
// uniqueness invariant: a second Enqueue for the same (lesson, kind, chunk)
// while the first is still active must return the existing record, never
// create a duplicate worker. This is what prevents a double-click of
// "Trích xuất transcript" from racing two Whisper calls.
func TestTaskStoreActiveUniqueness_RejectsSecondEnqueue(t *testing.T) {
	store := newSmokeTaskStore(t)
	tag := time.Now().UTC().Format("20060102150405.000000")
	lessonID := "smoke-uniq-" + tag
	userID := "smoke-uniq-user-" + tag
	smokeCleanLesson(t, lessonID)
	t.Cleanup(func() { smokeCleanLesson(t, lessonID) })

	ctx := context.Background()
	first, err := store.Enqueue(ctx, CreateLessonTaskInput{
		LessonID:  lessonID,
		Kind:      richterv1.LessonTaskKind_LESSON_TASK_KIND_EXTRACT_TRANSCRIPT,
		CreatedBy: userID,
	})
	if err != nil {
		t.Fatalf("first Enqueue: %v", err)
	}
	second, err := store.Enqueue(ctx, CreateLessonTaskInput{
		LessonID:  lessonID,
		Kind:      richterv1.LessonTaskKind_LESSON_TASK_KIND_EXTRACT_TRANSCRIPT,
		CreatedBy: userID,
	})
	if err != nil {
		t.Fatalf("second Enqueue: %v", err)
	}
	if second.ID != first.ID {
		t.Fatalf("active uniqueness violated: first=%s second=%s", first.ID, second.ID)
	}

	// Verify the active_target index still points to the first record.
	list, err := store.List(ctx, lessonID, true, 10, 0)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	count := 0
	for _, rec := range list {
		if rec.ID == first.ID {
			count++
		}
	}
	if count != 1 {
		t.Errorf("expected 1 active record for lesson, got %d", count)
	}
}

// TestTaskStorePerUserCap_EnforcesMaxActivePerUser verifies the
// MaxActivePerUser ceiling: after creating MaxActivePerUser active tasks
// for a user, the next Enqueue (even on a different lesson) must return
// errResourceExhausted. This protects the FDB queue + worker pool from a
// single user monopolising the system.
func TestTaskStorePerUserCap_EnforcesMaxActivePerUser(t *testing.T) {
	store := newSmokeTaskStore(t)
	tag := time.Now().UTC().Format("20060102150405.000000")
	userID := "smoke-cap-user-" + tag
	cap := store.taskCfg.MaxActivePerUser
	if cap < 1 {
		t.Skip("MaxActivePerUser not configured; skipping cap test")
	}

	// Enqueue `cap` tasks on distinct lessons so we don't trip active
	// uniqueness; track them so we can clean up.
	created := make([]string, 0, cap)
	for i := 0; i < cap; i++ {
		lessonID := "smoke-cap-lesson-" + tag + "-" + string(rune('a'+i))
		smokeCleanLesson(t, lessonID)
		_, err := store.Enqueue(context.Background(), CreateLessonTaskInput{
			LessonID:  lessonID,
			Kind:      richterv1.LessonTaskKind_LESSON_TASK_KIND_EXTRACT_TRANSCRIPT,
			CreatedBy: userID,
		})
		if err != nil {
			t.Fatalf("Enqueue #%d: %v", i, err)
		}
		created = append(created, lessonID)
	}
	t.Cleanup(func() {
		for _, lid := range created {
			smokeCleanLesson(t, lid)
		}
	})

	// The cap-th Enqueue (different lesson) must be rejected.
	overLesson := "smoke-cap-over-" + tag
	smokeCleanLesson(t, overLesson)
	t.Cleanup(func() { smokeCleanLesson(t, overLesson) })
	_, err := store.Enqueue(context.Background(), CreateLessonTaskInput{
		LessonID:  overLesson,
		Kind:      richterv1.LessonTaskKind_LESSON_TASK_KIND_EXTRACT_TRANSCRIPT,
		CreatedBy: userID,
	})
	if !errors.Is(err, errResourceExhausted) {
		t.Fatalf("want errResourceExhausted at cap, got %v", err)
	}
}

// TestTaskStoreConcurrentEnqueue_ExactlyOneWins stresses the FDB
// transactions that back active uniqueness: N goroutines Enqueue the
// same (lesson, kind, chunk) simultaneously. Exactly one task record
// must be created; every other call must return that same record id
// (idempotent re-enqueue) so a UI double-click never duplicates work.
func TestTaskStoreConcurrentEnqueue_ExactlyOneWins(t *testing.T) {
	store := newSmokeTaskStore(t)
	tag := time.Now().UTC().Format("20060102150405.000000")
	lessonID := "smoke-conc-" + tag
	userID := "smoke-conc-user-" + tag
	smokeCleanLesson(t, lessonID)
	t.Cleanup(func() { smokeCleanLesson(t, lessonID) })

	const N = 8
	results := make([]string, N)
	errs := make([]error, N)
	var start sync.WaitGroup
	start.Add(1)
	var done sync.WaitGroup
	done.Add(N)
	for i := 0; i < N; i++ {
		i := i
		go func() {
			defer done.Done()
			start.Wait()
			rec, err := store.Enqueue(context.Background(), CreateLessonTaskInput{
				LessonID:  lessonID,
				Kind:      richterv1.LessonTaskKind_LESSON_TASK_KIND_EXTRACT_TRANSCRIPT,
				CreatedBy: userID,
			})
			results[i] = rec.ID
			errs[i] = err
		}()
	}
	start.Done() // release all goroutines at once
	done.Wait()

	winners := map[string]int{}
	for i := 0; i < N; i++ {
		if errs[i] != nil {
			t.Fatalf("goroutine %d: %v", i, errs[i])
		}
		winners[results[i]]++
	}
	if len(winners) != 1 {
		t.Fatalf("expected exactly 1 winner, got %d distinct ids: %v", len(winners), winners)
	}
	for id, count := range winners {
		if count != N {
			t.Errorf("winner %s only matched %d/%d calls", id, count, N)
		}
	}

	// And the queue should only contain 1 row for this task.
	list, err := store.List(context.Background(), lessonID, true, 10, 0)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(list) != 1 {
		t.Errorf("expected 1 active record, got %d", len(list))
	}
}
