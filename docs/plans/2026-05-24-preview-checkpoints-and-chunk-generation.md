# Preview Checkpoints And Chunk Generation Fix

Date: 2026-05-24

## Reported Issues

- In teacher preview mode, quiz checkpoints do not reliably appear when reaching the expected video time.
- AI generation for one chunk with four different interaction types can save different `start_seconds` values in the same chunk, including `0`.
- The button label `Tạo thêm toàn lesson` mixes Vietnamese and English.
- Starting AI generation for another chunk while one chunk is already running aborts the first request and leaves that chunk stuck in a disabled running state until refresh.

## Findings

- Backend generation currently trusts `start_seconds` returned by Gemini per interaction type. For generated chunk interactions, this should be deterministic and tied to the chunk boundary instead.
- `StudentLessonView` only receives checkpoint updates from normal video `timeupdate` events. Manual seeking and video-ended edges are not explicitly forwarded from `VideoPlayer`.
- `TabExercises` uses a single `AbortController` and one `generatingChunkId`. Starting a second chunk calls `abort()` on the first stream, then the abort path returns without clearing the first chunk state.

## Implementation Plan

1. Normalize AI-generated interaction checkpoints on the backend to the chunk `end_seconds`, regardless of the raw Gemini `start_seconds`.
2. Update Gemini prompts to describe the deterministic checkpoint convention, reducing bad raw output even though the server enforces it.
3. Make `VideoPlayer` notify `StudentLessonView` on manual seek, native `seeked`, and `ended`, so preview/test seeking can trigger checkpoints.
4. Replace single per-chunk generation UI state with a set of open generation forms and a controller map keyed by chunk ID. Do not abort other chunks when a new chunk starts.
5. Change visible labels from `lesson` to `bài học` in the affected controls.
6. Add focused tests for backend checkpoint normalization and update existing Playwright coverage where useful.

## Verification

- `go test ./golang/richter/internal/svc/ai`
- `go vet ./golang/richter/...`
- `pnpm --filter heino exec tsc --noEmit`
- Run targeted Playwright only if the local `richter` and `heino` services are available in the expected test/dev configuration.
