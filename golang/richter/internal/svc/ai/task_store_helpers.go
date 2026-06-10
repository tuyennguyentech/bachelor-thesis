package ai

import (
	"context"
	"errors"
	"fmt"
	"time"

	richterv1 "example.com/buf/gen/richter/v1"
	fdb "github.com/apple/foundationdb/bindings/go/src/fdb"
	"github.com/apple/foundationdb/bindings/go/src/fdb/tuple"
)

func isTerminal(s richterv1.LessonTaskStatus) bool {
	switch s {
	case richterv1.LessonTaskStatus_LESSON_TASK_STATUS_SUCCEEDED,
		richterv1.LessonTaskStatus_LESSON_TASK_STATUS_FAILED,
		richterv1.LessonTaskStatus_LESSON_TASK_STATUS_CANCELED:
		return true
	}
	return false
}

func readTaskRecordInTx(tr fdb.Transaction, taskID string) (lessonTaskRecord, bool, error) {
	bytes := tr.Get(taskRecordKey(taskID)).MustGet()
	if bytes == nil {
		return lessonTaskRecord{}, false, nil
	}
	rec, ok := fromFdbLessonTaskRecord(bytes)
	if !ok {
		return lessonTaskRecord{}, false, fmt.Errorf("ai: corrupt task record %s", taskID)
	}
	return rec, true, nil
}

func (s *LessonTaskStore) updateStatus(
	ctx context.Context,
	taskID string,
	from, to richterv1.LessonTaskStatus,
	mutate func(*lessonTaskRecord),
) (lessonTaskRecord, error) {
	result, err := s.kv.Transact(func(tr fdb.Transaction) (any, error) {
		rec, ok, readErr := readTaskRecordInTx(tr, taskID)
		if readErr != nil {
			return lessonTaskRecord{}, readErr
		}
		if !ok {
			return lessonTaskRecord{}, errTaskNotFound
		}
		if rec.Status != from {
			return rec, nil
		}
		rec.Status = to
		rec.UpdatedAt = time.Now().UTC()
		if mutate != nil {
			mutate(&rec)
		}
		recBytes, marshalErr := marshalLessonTaskRecord(rec)
		if marshalErr != nil {
			return lessonTaskRecord{}, marshalErr
		}
		tr.Set(taskRecordKey(rec.ID), recBytes)
		return rec, nil
	})
	if err != nil {
		if errors.Is(err, errTaskNotFound) {
			return lessonTaskRecord{}, err
		}
		return lessonTaskRecord{}, fmt.Errorf("ai: update status: %w", err)
	}
	return result.(lessonTaskRecord), nil
}

func (s *LessonTaskStore) completeTask(
	ctx context.Context,
	taskID string,
	status richterv1.LessonTaskStatus,
	message, errMsg string,
) (lessonTaskRecord, error) {
	result, err := s.kv.Transact(func(tr fdb.Transaction) (any, error) {
		rec, ok, readErr := readTaskRecordInTx(tr, taskID)
		if readErr != nil {
			return lessonTaskRecord{}, readErr
		}
		if !ok {
			return lessonTaskRecord{}, errTaskNotFound
		}
		if isTerminal(rec.Status) {
			return rec, nil
		}
		now := time.Now().UTC()
		rec.Status = status
		rec.Message = message
		rec.ErrorMsg = errMsg
		rec.UpdatedAt = now
		rec.FinishedAt = now
		recBytes, marshalErr := marshalLessonTaskRecord(rec)
		if marshalErr != nil {
			return lessonTaskRecord{}, marshalErr
		}
		tr.Set(taskRecordKey(rec.ID), recBytes)
		tr.Clear(taskActiveTargetKey(rec.LessonID, rec.Kind, rec.ChunkID))
		tr.Clear(taskByLessonKey(rec.LessonID, "active", rec.CreatedAt, rec.ID))
		tr.Clear(taskByUserKey(rec.CreatedBy, "active", rec.CreatedAt, rec.ID))
		return rec, nil
	})
	if err != nil {
		if errors.Is(err, errTaskNotFound) {
			return lessonTaskRecord{}, err
		}
		return lessonTaskRecord{}, fmt.Errorf("ai: complete task: %w", err)
	}
	return result.(lessonTaskRecord), nil
}

// countActiveByUser reads keys in the by_user/<user>/active index OUTSIDE
// the Enqueue transaction. Reading inside the same tx as the writes would
// either (a) require a snapshot read to avoid infinite FDB retry when a key
// inside the range is written, or (b) trigger a self-conflict. Keeping the
// read here means the Enqueue transaction only does the writes, and the
// small race window (cap may be exceeded by at most 1 under burst) is
// accepted: a stricter cap would require an FDB atomic counter key, which
// adds complexity for a soft cap.
func (s *LessonTaskStore) countActiveByUser(userID string) (int, error) {
	prefix := tuple.Tuple{kvNsLessonTask, "by_user", userID, "active"}
	rng, err := s.kv.RawPrefix(kvNsLessonTask, prefix)
	if err != nil {
		return 0, err
	}
	var count int
	_, txnErr := s.kv.Transact(func(tr fdb.Transaction) (any, error) {
		kvs, err := tr.Snapshot().GetRange(rng, fdb.RangeOptions{Limit: 1000}).GetSliceWithError()
		if err != nil {
			return nil, err
		}
		count = len(kvs)
		return nil, nil
	})
	if txnErr != nil {
		return 0, txnErr
	}
	return count, nil
}

// lastQueueSeqInTx reads the highest sequence number in the queue and returns
// it. Returns 0 if the queue is empty. Uses a snapshot read so the read range
// does not conflict with the transaction's own write to a key inside the
// queue range later in Enqueue.
func (s *LessonTaskStore) lastQueueSeqInTx(tr fdb.Transaction) (int64, error) {
	prefix := taskQueueKeyPrefix()
	rng, err := s.kv.RawPrefix(kvNsLessonTask, prefix)
	if err != nil {
		return 0, err
	}
	rows := tr.Snapshot().GetRange(fdb.KeyRange{Begin: rng.Begin, End: rng.End},
		fdb.RangeOptions{Limit: 1, Reverse: true}).Iterator()
	if !rows.Advance() {
		return 0, nil
	}
	parts, err := tuple.Unpack(rows.MustGet().Key)
	if err != nil {
		return 0, err
	}
	if len(parts) < 3 {
		return 0, nil
	}
	seq, ok := parts[2].(int64)
	if !ok {
		return 0, nil
	}
	return seq, nil
}
