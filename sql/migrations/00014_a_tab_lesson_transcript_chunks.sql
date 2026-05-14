-- +goose Up
CREATE TABLE lesson_transcript_chunks (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  lesson_id uuid NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  order_index integer NOT NULL DEFAULT 0,
  start_seconds float NOT NULL DEFAULT 0,
  end_seconds float NOT NULL DEFAULT 0,
  summary text NOT NULL DEFAULT '',
  transcript text NOT NULL DEFAULT '',
  question_count_config integer NOT NULL DEFAULT 1,
  created_at timestamp NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
  updated_at timestamp NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
);

CREATE INDEX lesson_transcript_chunks_lesson_id_idx ON lesson_transcript_chunks(lesson_id);

CREATE OR REPLACE TRIGGER lesson_transcript_chunks_set_updated_at
BEFORE UPDATE ON lesson_transcript_chunks
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

ALTER TABLE lesson_questions ADD COLUMN chunk_id uuid REFERENCES lesson_transcript_chunks(id) ON DELETE SET NULL;

-- +goose Down
ALTER TABLE lesson_questions DROP COLUMN IF EXISTS chunk_id;
DROP TRIGGER IF EXISTS lesson_transcript_chunks_set_updated_at ON lesson_transcript_chunks;
DROP INDEX IF EXISTS lesson_transcript_chunks_lesson_id_idx;
DROP TABLE IF EXISTS lesson_transcript_chunks;
