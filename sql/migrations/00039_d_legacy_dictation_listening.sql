-- +goose Up
-- The listening exercise is now always a single MCQ whose question is delivered as
-- AUDIO (synthesised from audio_source_text). The legacy "dictation" mode and any
-- listening row with no MCQ are un-answerable under the new model — remove them so
-- they don't contribute an inert 0-max item to lessons.
DELETE FROM lesson_interactions
WHERE kind = 'listening'
  AND (
    config->>'mode' = 'dictation'
    OR COALESCE(jsonb_array_length(config->'comprehension_questions'), 0) = 0
  );

-- +goose Down
-- (legacy dictation/empty listening data is not restored on rollback)
SELECT 1;
