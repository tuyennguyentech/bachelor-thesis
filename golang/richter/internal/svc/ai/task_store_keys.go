package ai

import (
	"crypto/rand"
	"encoding/binary"
	"time"

	richterv1 "example.com/buf/gen/richter/v1"
	fdb "github.com/apple/foundationdb/bindings/go/src/fdb"
	"github.com/apple/foundationdb/bindings/go/src/fdb/tuple"
)

const (
	// kvNsLessonTask is the FoundationDB namespace for durable lesson tasks.
	kvNsLessonTask = "lesson_task"

	// taskChunkNone is the sentinel used in FDB tuple keys for tasks that
	// are not chunk-scoped (e.g. EXTRACT_TRANSCRIPT, CHUNK_TRANSCRIPT). The
	// FoundationDB tuple packer refuses to encode "" at the end of a key
	// because it collides with the terminator byte, so we substitute a
	// non-empty value that is never a valid chunk id.
	taskChunkNone = "_"
)

// taskActiveTargetKey is the FDB key holding the active task ID for a given
// (lesson, kind, chunk) target. Used for both existence checks during create
// and atomic claim during dequeue. An empty chunkID is replaced with the
// taskChunkNone sentinel because the FDB tuple packer cannot encode an empty
// string as a key element. The kind is encoded as int64 because the FDB tuple
// packer does not support int32 (it only supports int / int64 / uint64).
func taskActiveTargetKey(lessonID string, kind richterv1.LessonTaskKind, chunkID string) fdb.Key {
	if chunkID == "" {
		chunkID = taskChunkNone
	}
	t := tuple.Tuple{kvNsLessonTask, "active_target", lessonID, int64(kind), chunkID}
	return t.Pack()
}

func taskRecordKey(taskID string) fdb.Key {
	t := tuple.Tuple{kvNsLessonTask, "r", taskID}
	return t.Pack()
}

func taskQueueKeyPrefix() tuple.Tuple {
	return tuple.Tuple{kvNsLessonTask, "queue"}
}

func taskQueueKey(seq int64) fdb.Key {
	suffix := make([]byte, 16)
	if _, err := rand.Read(suffix); err != nil {
		// Fallback: time-based suffix keeps the queue conflict-free even if
		// the CSPRNG is unavailable.
		binary.LittleEndian.PutUint64(suffix, uint64(time.Now().UnixNano()))
		binary.LittleEndian.PutUint64(suffix[8:], uint64(seq))
	}
	t := tuple.Tuple{kvNsLessonTask, "queue", seq, suffix}
	return t.Pack()
}

func taskByLessonKey(lessonID, bucket string, timestamp time.Time, taskID string) fdb.Key {
	t := tuple.Tuple{kvNsLessonTask, "by_lesson", lessonID, bucket, timestamp.UTC().UnixNano(), taskID}
	return t.Pack()
}

func taskByUserKey(userID, bucket string, timestamp time.Time, taskID string) fdb.Key {
	t := tuple.Tuple{kvNsLessonTask, "by_user", userID, bucket, timestamp.UTC().UnixNano(), taskID}
	return t.Pack()
}

func taskCancelSignalKey(taskID string) fdb.Key {
	t := tuple.Tuple{kvNsLessonTask, "cancel_signal", taskID}
	return t.Pack()
}
