-- name: InsertLessonTranscriptChunk :one
INSERT INTO lesson_transcript_chunks (lesson_id, order_index, start_seconds, end_seconds, summary, question_count_config, coherence_score)
VALUES ($1, $2, $3, $4, $5, $6, $7)
RETURNING *;

-- name: ListLessonTranscriptChunks :many
SELECT * FROM lesson_transcript_chunks WHERE lesson_id = $1 ORDER BY order_index ASC LIMIT $2 OFFSET $3;

-- name: DeleteLessonTranscriptChunks :exec
DELETE FROM lesson_transcript_chunks WHERE lesson_id = $1;

-- name: UpdateChunkQuestionCountConfig :one
UPDATE lesson_transcript_chunks SET question_count_config = $2 WHERE id = $1 RETURNING *;

-- name: GetLessonTranscriptChunk :one
SELECT * FROM lesson_transcript_chunks WHERE id = $1;

-- name: DeleteLessonTranscriptChunk :exec
DELETE FROM lesson_transcript_chunks WHERE id = $1;

-- name: UpdateChunkMetadata :one
UPDATE lesson_transcript_chunks
SET start_seconds = $2, end_seconds = $3, summary = $4, coherence_score = $5
WHERE id = $1
RETURNING *;

-- name: UpdateChunkCoherence :exec
UPDATE lesson_transcript_chunks SET coherence_score = $2 WHERE id = $1;

-- name: UpdateChunkInteractionConfig :one
UPDATE lesson_transcript_chunks
SET interaction_config = $2, updated_at = NOW()
WHERE id = $1
RETURNING *;

-- name: ReorderLessonChunks :exec
UPDATE lesson_transcript_chunks
SET order_index = reordered.new_index
FROM (
    SELECT id, (ROW_NUMBER() OVER (ORDER BY start_seconds) - 1)::int AS new_index
    FROM lesson_transcript_chunks
    WHERE lesson_id = $1
) AS reordered
WHERE lesson_transcript_chunks.id = reordered.id
  AND lesson_transcript_chunks.lesson_id = $1;
