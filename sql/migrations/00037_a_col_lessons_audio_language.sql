-- Per-lesson SPOKEN/audio language for the source video, distinct from the
-- lesson's OUTPUT language (lessons.language, which controls generated
-- questions/exercises). A teacher may study a Vietnamese video but want English
-- exercises, or vice-versa. This value is sent to Whisper as the transcription
-- language hint so the transcript follows the ACTUAL audio — not the output
-- language and not Whisper's unreliable auto-detect. NULL/empty = auto-detect.

-- +goose Up
ALTER TABLE lessons ADD COLUMN audio_language text NOT NULL DEFAULT '';

-- +goose Down
ALTER TABLE lessons DROP COLUMN audio_language;
