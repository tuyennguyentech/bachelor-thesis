-- +goose Up
ALTER TABLE lesson_transcript_chunks
    ADD COLUMN IF NOT EXISTS interaction_config jsonb;

COMMENT ON COLUMN lesson_transcript_chunks.interaction_config IS
'AI generation config: { count: int, kinds: [string], strategy: "ai_choose"|"even" }';

ALTER TABLE lessons
    ADD COLUMN IF NOT EXISTS default_interaction_config jsonb;

COMMENT ON COLUMN lessons.default_interaction_config IS
'Default AI generation config applied to chunks that have no interaction_config set';

-- +goose Down
ALTER TABLE lesson_transcript_chunks DROP COLUMN IF EXISTS interaction_config;
ALTER TABLE lessons DROP COLUMN IF EXISTS default_interaction_config;
