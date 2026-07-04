/**
 * Regressions for the quick-create / "Xử lý video" processing tab, from a real
 * bug report on lesson "Class, Object và Constructor":
 *
 *  - Bug D4: after a video is uploaded the upload step looked empty (no preview).
 *  - Bug C:  re-running transcribe left the later steps falsely "done" (green)
 *            with the previous run's questions still shown, even though the
 *            backend had wiped chunks + interactions.
 *
 * (The transcription repetition-loop root cause — missing vad_filter — is covered
 * by the Go unit test TestIsDegenerateTranscript and the STT request change; it is
 * not reproducible deterministically from the browser.)
 */
import { createClient, type Interceptor } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { AIService, AnalysisStatus, LessonTaskKind, LessonTaskStatus } from "buf/gen/richter/v1/ai_pb";
import { StorageService } from "buf/gen/richter/v1/storage_pb";
import fs from "node:fs";
import {
  test,
  expect,
  createAnalyzedLesson,
  seedMidPipelineTranscript,
  seedProcessingTask,
  seedFailedTranscribeWithStaleChunks,
  createInteraction,
  InteractionKind,
  uploadLessonVideo,
  INVALID_VIDEO,
  getTeacherAuth,
  getOrgId,
  createCourse,
  createCourseModule,
  createLesson,
  lessonUrlFor,
  uid,
  SEED_HUST_CS_SLUG,
} from "../fixtures";

function rpcBaseUrl(baseURL?: string) {
  return process.env.RICHTER_BASE_URL ?? `${baseURL ?? "http://caddy"}/api/richter`;
}

function authedTransport(token: string) {
  const authInterceptor: Interceptor = (next) => async (req) => {
    req.header.set("Authorization", `Bearer ${token}`);
    return next(req);
  };
  return createConnectTransport({ httpVersion: "1.1", baseUrl: rpcBaseUrl(), interceptors: [authInterceptor] });
}

function aiClient(token: string) {
  return createClient(AIService, authedTransport(token));
}

function storageClient(token: string) {
  return createClient(StorageService, authedTransport(token));
}

test.describe("Processing tab regressions", () => {
  test("D4: upload step renders a video preview for a lesson that has a video", async ({ teacherPage: page }) => {
    // createAnalyzedLesson uploads a real video + registers its storage key.
    const { lessonUrl } = await createAnalyzedLesson();
    await page.goto(`${lessonUrl}?tab=processing`, { waitUntil: "domcontentloaded" });
    // The upload step is "done"; open it to view the upload sub-step.
    await page.getByTestId("workflow-step-upload").click();
    // The fix: an inline <video> preview appears on the upload step (previously the
    // step looked empty because the presigned videoUrl was never threaded in).
    await expect(page.getByTestId("upload-step-video-preview")).toBeVisible({ timeout: 10_000 });
  });

  test("C: re-running transcribe clears the exercise step's done state + stale questions", async ({ teacherPage: page }) => {
    test.setTimeout(360_000);
    const { lessonUrl, lessonId, token } = await createAnalyzedLesson();
    // Give the lesson real interactions so the exercise step reads "done".
    await createInteraction(token, lessonId, { prompt: "Câu hỏi seed 1", startSeconds: 1 });
    await createInteraction(token, lessonId, { prompt: "Câu hỏi seed 2", startSeconds: 3 });

    await page.goto(`${lessonUrl}?tab=processing`, { waitUntil: "domcontentloaded" });
    // Precondition: the exercise step shows a question count (it is "done").
    await expect(page.getByTestId("workflow-step-exercises")).toContainText(/câu/i, { timeout: 15_000 });

    // Re-run transcribe out-of-band; the open page's task tracker will observe it.
    await aiClient(token).startLessonTask({ lessonId, kind: 1 /* LESSON_TASK_KIND_EXTRACT_TRANSCRIPT */ });

    // Wait until the re-transcribe has fully COMPLETED and the UI has SETTLED
    // (transcribing=false again) — signalled by the chunk-step CTA re-appearing.
    // This is exactly the moment the bug resurfaced: pre-fix the exercise step
    // flipped back to green with the old "N câu" once transcribing ended. Asserting
    // here (not during the transient transcribing window) actually exercises the fix.
    await expect(
      page.getByRole("button", { name: /Phân đoạn bài học/i }).first(),
    ).toBeVisible({ timeout: 300_000 });
    // The fix: interactions were reset on extract success, so the exercise step is
    // no longer "done" and shows no stale question count.
    await expect(page.getByTestId("workflow-step-exercises")).not.toContainText(/câu/i);
  });

  test("D2: completed steps stay read-only navigable during a running quick-create pipeline", async ({ teacherPage: page }) => {
    test.setTimeout(300_000);
    const { lessonUrl, lessonId, token } = await createAnalyzedLesson();
    await page.goto(`${lessonUrl}?tab=processing`, { waitUntil: "domcontentloaded" });
    // Kick a full pipeline; the open page's tracker will pick it up as active.
    await aiClient(token).startLessonTask({ lessonId, kind: 4 /* LESSON_TASK_KIND_RUN_PIPELINE */ });
    // Pipeline is now active (banner shown for the whole run). Pre-fix, displayStep
    // was hard-pinned to the live stage, so clicking an earlier completed step was a
    // silent no-op (body never switched — the "steps locked" report in Image #11).
    await expect(page.getByText(/Bạn không cần thao tác gì/i)).toBeVisible({ timeout: 90_000 });
    await page.getByTestId("workflow-step-upload").click();
    // The fix (read-only manualStep override): the body switches to the upload step,
    // so its lightweight "uploaded" indicator renders even while the pipeline runs.
    await expect(page.getByTestId("upload-step-video-preview")).toBeVisible({ timeout: 20_000 });
  });

  test("#12: re-transcribe clears the stale transcript from BOTH the step and the video tab, then re-syncs", async ({ teacherPage: page }) => {
    // Real transcription runs twice (setup + re-transcribe), so allow generous time.
    test.setTimeout(420_000);
    const { lessonUrl, lessonId, token } = await createAnalyzedLesson();
    const url = lessonUrl.split("?")[0];
    const client = aiClient(token);
    const stepSegments = page.locator('[data-testid^="edit-transcript-segment-"]');
    // Wait until the lesson-level transcript is actually persisted server-side.
    const transcriptPersisted = () =>
      expect
        .poll(
          async () => (await client.getLessonAnalysis({ lessonId }).catch(() => null))?.analysis?.transcriptSegments.length ?? 0,
          { timeout: 300_000, intervals: [2000] },
        )
        .toBeGreaterThan(0);

    // ── Precondition: a REAL persisted transcript (EXTRACT #1) so the page loads
    //    already showing it on BOTH the "Chỉnh sửa transcript" step AND the video tab
    //    — exactly the state the bug report (Image #15) starts from. ──
    await client.startLessonTask({ lessonId, kind: 1 /* EXTRACT_TRANSCRIPT */ });
    await transcriptPersisted();
    await page.goto(`${url}?tab=processing`, { waitUntil: "domcontentloaded" });
    // Extract auto-advances the workflow to the chunks step; open the transcript step
    // so its editor (the segment rows) renders.
    await page.getByTestId("workflow-step-transcript").click();
    await expect(stepSegments.first()).toBeVisible({ timeout: 30_000 });
    await page.getByRole("tab", { name: /Bài giảng/i }).click();
    await expect(page.getByTestId("interactive-transcript").first()).toBeVisible({ timeout: 30_000 });

    // ── Re-transcribe through the REAL UI: transcript step → "Trích xuất lại" →
    //    confirm "Xoá và trích xuất lại" (this is what the teacher actually clicks). ──
    await page.getByRole("tab", { name: /Xử lý video/i }).click();
    await page.getByTestId("workflow-step-transcript").click();
    await page.getByRole("button", { name: /Trích xuất lại/i }).click();
    await page.getByRole("button", { name: /Xoá và trích xuất lại/i }).click();

    // ── THE BUG (Image #15): the old transcript stayed "còn nguyên" on the step AND
    //    the video tab for the whole re-transcribe, even though the server had already
    //    wiped it. THE FIX: both surfaces clear the instant the re-transcribe starts. ──
    await expect(stepSegments).toHaveCount(0, { timeout: 20_000 });
    await page.getByRole("tab", { name: /Bài giảng/i }).click();
    await expect(page.getByTestId("interactive-transcript")).toHaveCount(0, { timeout: 20_000 });

    // ── After the re-transcribe completes, the NEW transcript re-syncs to both
    //    surfaces (the completion auto-advances the body to the chunks step, so
    //    re-open the transcript step to render its editor). ──
    await transcriptPersisted();
    await page.getByRole("tab", { name: /Xử lý video/i }).click();
    await page.getByTestId("workflow-step-transcript").click();
    await expect(stepSegments.first()).toBeVisible({ timeout: 90_000 });
    await page.getByRole("tab", { name: /Bài giảng/i }).click();
    await expect(page.getByTestId("interactive-transcript").first()).toBeVisible({ timeout: 30_000 });
  });

  test("#6: transcript appears in the video tab WHILE a quick-create pipeline is still running", async ({ teacherPage: page }) => {
    test.setTimeout(300_000);
    const { lessonUrl, lessonId, token } = await createAnalyzedLesson();
    await page.goto(`${lessonUrl}?tab=processing`, { waitUntil: "domcontentloaded" });
    await aiClient(token).startLessonTask({ lessonId, kind: 4 /* RUN_PIPELINE */ });
    // Confirm the pipeline actually started (the no-action banner appears).
    await expect(page.getByText(/Bạn không cần thao tác gì/i)).toBeVisible({ timeout: 90_000 });
    // The fix loads segments when the pipeline leaves TRANSCRIBING and publishes them
    // to the live context → the video tab's transcript syncs in-place during the
    // quick-create flow, without a reload (the "phiên âm ko sync khi tạo nhanh"
    // report). Pre-fix, segments were only loaded at terminal pipeline success.
    await page.getByRole("tab", { name: /Bài giảng/i }).click();
    await expect(page.getByTestId("interactive-transcript")).toBeVisible({ timeout: 120_000 });
  });

  test("A/B: 'Xoá toàn bộ nội dung' fully resets the stepper (no stale transcript, chunking locked) and survives re-upload", async ({ teacherPage: page }) => {
    test.setTimeout(180_000);
    // A fully-analyzed lesson leaves SUCCEEDED task rows (video + transcript +
    // chunks + tasks) — exactly the state where the reset bug reproduced.
    const { lessonUrl, lessonId, token } = await createAnalyzedLesson();
    const url = lessonUrl.split("?")[0];
    await page.goto(`${url}?tab=processing`, { waitUntil: "domcontentloaded" });

    // Precondition: the transcript step reports a transcript exists.
    await expect(page.getByTestId("workflow-step-transcript")).toContainText(/Đã phiên âm/, { timeout: 15_000 });

    // Reset ALL content.
    await page.getByTestId("reset-lesson-button").click();
    await page.getByTestId("reset-lesson-confirm").click();

    // BUG A: the stepper must fully reset. Pre-fix, leftover succeeded task rows kept
    // GetLessonAnalysis reporting CHUNKS_READY → step 2 stayed "Đã phiên âm" and
    // step 3 (chunks) stayed unlocked/runnable even with no video.
    await expect(page.getByTestId("workflow-step-upload")).toContainText(/Chờ tải video/, { timeout: 20_000 });
    await expect(page.getByTestId("workflow-step-transcript")).not.toContainText(/Đã phiên âm/);
    await expect(page.getByTestId("workflow-step-chunks")).toHaveAttribute("aria-disabled", "true");
    // ...and chunking must NOT be runnable — the user's exact complaint ("vẫn bấm chạy
    // phân đoạn được"). Pre-fix, clicking the (falsely-ready) chunks step revealed a
    // "Phân đoạn bài học" run button; after the fix no such run affordance exists.
    await page.getByTestId("workflow-step-chunks").click({ force: true });
    await expect(page.getByRole("button", { name: /Phân đoạn bài học/ })).toHaveCount(0);

    // BUG B: re-upload the (old) video → step 2 must STILL not claim a transcript
    // exists (the backend genuinely has none after the wipe). Pre-fix, the leftover
    // task made it instantly show "Đã phiên âm" again while chunking failed
    // server-side with "no transcript found".
    await uploadLessonVideo(token, lessonId);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("workflow-step-upload")).toContainText(/Đã tải lên/, { timeout: 20_000 });
    await expect(page.getByTestId("workflow-step-transcript")).not.toContainText(/Đã phiên âm/);
    await expect(page.getByTestId("workflow-step-chunks")).toHaveAttribute("aria-disabled", "true");
    // Still no runnable chunk affordance after re-upload (transcript genuinely absent).
    await page.getByTestId("workflow-step-chunks").click({ force: true });
    await expect(page.getByRole("button", { name: /Phân đoạn bài học/ })).toHaveCount(0);
  });

  test("A2: re-transcribe after a completed pipeline lands on Phân đoạn (not the locked Bài tập step)", async ({ teacherPage: page }) => {
    test.setTimeout(600_000);
    const { lessonUrl, lessonId, token } = await createAnalyzedLesson();
    const url = lessonUrl.split("?")[0];
    const client = aiClient(token);

    // 1) Run the full pipeline (the quick-create path) → chunks + interactions + a
    //    SUCCEEDED pipeline_run task ⟹ analysis status DONE. Wait for the pipeline to
    //    FULLY finish (status DONE) before re-transcribing — starting a transcribe
    //    while the pipeline is still active is rejected ("Phân tích đang được xử lý").
    await client.startLessonTask({ lessonId, kind: 4 /* LESSON_TASK_KIND_RUN_PIPELINE */ });
    await expect
      .poll(async () => (await client.getLessonAnalysis({ lessonId }).catch(() => null))?.analysis?.status ?? 0,
        { timeout: 360_000, intervals: [3000] })
      .toBe(AnalysisStatus.DONE);

    // 2) Re-transcribe ("Trích xuất lại") → wipes chunks + interactions. The leftover
    //    SUCCEEDED pipeline_run task must NOT keep the status at DONE — otherwise the
    //    stepper lands on the LOCKED "Bài tập" step (Image #2). Fixed by the executor
    //    task-cleanup + the read-side artifact ceiling. Retry the start until accepted
    //    (the pipeline's final commit may still be settling right after status=DONE).
    await expect
      .poll(async () => {
        try { await client.startLessonTask({ lessonId, kind: 1 /* EXTRACT_TRANSCRIPT */ }); return true; }
        catch { return false; }
      }, { timeout: 60_000, intervals: [3000] })
      .toBe(true);
    await expect
      .poll(async () => {
        const r = await client.getLessonAnalysis({ lessonId }).catch(() => null);
        return (r?.chunks.length ?? -1) === 0 && (r?.analysis?.transcriptSegments.length ?? 0) > 0;
      }, { timeout: 240_000, intervals: [3000] })
      .toBe(true);

    // 3) Fresh load → the stepper must land on the runnable "Phân đoạn" step, NOT the
    //    locked "Bài tập" step. Pre-fix: status stayed DONE ⟹ getInitialWorkflowStep
    //    returned "exercises" ⟹ locked "Thiết kế bài tập chưa sẵn sàng".
    await page.goto(`${url}?tab=processing`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("button", { name: /Phân đoạn bài học/ }).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Thiết kế bài tập chưa sẵn sàng/)).toHaveCount(0);
  });

  test("A3: transcript is available WHILE the pipeline is still running (not only after it finishes)", async ({ baseURL }) => {
    test.setTimeout(300_000);
    // A FRESH lesson (no seeded succeeded tasks) so the ONLY task is the pipeline_run
    // — exactly the state where the transcript was hidden mid-flight (Image #3): the
    // composite task stays PROCESSING while its transcribe stage already saved
    // segments. Uses the API only (no page needed).
    const { token, userId } = await getTeacherAuth(baseURL);
    const orgId = await getOrgId(token, SEED_HUST_CS_SLUG, baseURL);
    const courseId = await createCourse(token, orgId, uid("A3-Course"), userId, baseURL);
    const moduleId = await createCourseModule(token, courseId, uid("A3-Module"), baseURL);
    const lessonId = await createLesson(token, moduleId, uid("A3-Lesson"), baseURL);
    await uploadLessonVideo(token, lessonId, { baseURL });
    const client = aiClient(token);

    await client.startLessonTask({ lessonId, kind: 4 /* LESSON_TASK_KIND_RUN_PIPELINE */ });

    // Poll frequently and capture the analysis status the FIRST time segments appear.
    let statusAtFirstSegments: number | null = null;
    await expect
      .poll(async () => {
        const r = await client.getLessonAnalysis({ lessonId }).catch(() => null);
        const segs = r?.analysis?.transcriptSegments.length ?? 0;
        if (segs > 0 && statusAtFirstSegments === null) statusAtFirstSegments = r!.analysis!.status;
        return segs;
      }, { timeout: 240_000, intervals: [1000] })
      .toBeGreaterThan(0);

    // The transcript must have surfaced WHILE the pipeline was still running. Pre-fix
    // `canLoadTranscript` needed a SUCCEEDED task, so segments only appeared once the
    // pipeline_run reached SUCCEEDED (status DONE) — i.e. never mid-flight.
    expect(statusAtFirstSegments).not.toBe(AnalysisStatus.DONE);
  });

  test("A4: transcript RENDERS on both the video tab AND the processing step during a PROCESSING pipeline (deterministic UI repro of Image #3)", async ({ teacherPage: page, baseURL }) => {
    test.setTimeout(120_000);
    // DETERMINISTIC reproduction of Image #3 — no real pipeline, no Gemini/Whisper,
    // no timing window to race. seedMidPipelineTranscript plants lesson-level
    // segments in FDB with the ONLY task being a PROCESSING pipeline_run (no
    // succeeded task). This is the state createAnalyzedLesson CANNOT produce: it
    // always plants a synthetic SUCCEEDED task, which satisfied the old
    // `canLoadTranscript` gate and is exactly why the earlier E2E stayed green while
    // the real app was broken. Pre-fix GetLessonAnalysis returned 0 segments here →
    // BOTH tabs blank; post-fix it loads them unconditionally from FDB.
    const seg1 = "Xin chào, đây là dòng phiên âm thứ nhất của bài giảng.";
    const seg2 = "Và đây là dòng phiên âm thứ hai, vẫn đang trong lúc xử lý.";
    const { lessonUrl } = await seedMidPipelineTranscript(baseURL, [seg1, seg2]);

    // Tab "Bài giảng": the InteractiveTranscript must render BOTH seeded lines WHILE
    // the pipeline is still PROCESSING (pre-fix the segments prop was empty → no rows).
    await page.goto(lessonUrl, { waitUntil: "domcontentloaded" });
    const transcript = page.getByTestId("interactive-transcript");
    await expect(transcript).toBeVisible({ timeout: 30_000 });
    await expect(transcript.getByTestId("transcript-segment-0")).toContainText(seg1);
    await expect(transcript.getByTestId("transcript-segment-1")).toContainText(seg2);
    await expect(transcript.locator('[data-testid^="transcript-segment-"]')).toHaveCount(2);

    // Tab "Xử lý video": the transcript step subtitle must read "2 dòng" (the real
    // segment count). Pre-fix it read "Đã phiên âm" (hasTranscriptContent but
    // hasSegments=false) — the precise Image #3 symptom.
    await page.goto(`${lessonUrl}?tab=processing`, { waitUntil: "domcontentloaded" });
    await expect(page.getByText(/2 dòng/)).toBeVisible({ timeout: 30_000 });
  });

  test("A5: Quick-Create HIDES the 4 transcribe sub-steps (single spinner); standalone re-transcribe SHOWS them", async ({ teacherPage: page, baseURL }) => {
    test.setTimeout(120_000);
    // Deterministic — no real pipeline. seedProcessingTask plants ONE in-progress task
    // (no succeeded task) at a chosen stage. "stream-progress" is the per-sub-step strip
    // container; "Tải video từ storage" is the DOWNLOADING step label that ONLY appears
    // in that strip (never in the hero), so it's a clean discriminator.

    // 1) Quick-Create pipeline at the TRANSCRIBING stage → strip HIDDEN, hero spinner shown.
    const pipeline = await seedProcessingTask({ taskType: "pipeline_run", stage: "TRANSCRIBING", baseURL });
    await page.goto(`${pipeline.lessonUrl}?tab=processing`, { waitUntil: "domcontentloaded" });
    // The transcript hero (spinner + "Đang phiên âm") is present...
    await expect(page.getByTestId("extract-progress")).toBeVisible({ timeout: 30_000 });
    // ...but the 4 detailed sub-steps are hidden (coarse pipeline stage).
    await expect(page.getByTestId("stream-progress")).toHaveCount(0);
    await expect(page.getByText("Tải video từ storage")).toHaveCount(0);

    // 2) Standalone re-transcribe at the ANALYZING sub-step → strip SHOWN with 4 steps.
    const standalone = await seedProcessingTask({
      taskType: "transcribe",
      stage: "ANALYSIS_PROGRESS_STEP_ANALYZING",
      baseURL,
    });
    await page.goto(`${standalone.lessonUrl}?tab=processing`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("stream-progress")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Tải video từ storage")).toBeVisible();
  });

  test("A6: video-tab 'Xem thử' is gated on exercises — disabled without, enabled link with", async ({ teacherPage: page, baseURL }) => {
    test.setTimeout(120_000);
    // Preview before exercises exist == just watching the video tab, so the video-tab
    // "Xem thử" must match the workflow-step gate: available only once exercises exist.
    // No exercises → button present but DISABLED.
    const noEx = await createAnalyzedLesson(baseURL);
    await page.goto(noEx.lessonUrl, { waitUntil: "domcontentloaded" }); // default tab = content (video)
    const disabled = page.getByRole("button", { name: "Xem thử" });
    await expect(disabled).toBeVisible({ timeout: 30_000 });
    await expect(disabled).toBeDisabled();

    // With an exercise → it becomes an enabled link into the student preview.
    const withEx = await createAnalyzedLesson(baseURL);
    await createInteraction(withEx.token, withEx.lessonId, { prompt: "Câu hỏi xem thử", startSeconds: 1 });
    await page.goto(withEx.lessonUrl, { waitUntil: "domcontentloaded" });
    const enabled = page.getByRole("link", { name: "Xem thử" });
    await expect(enabled).toBeVisible({ timeout: 30_000 });
    await expect(enabled).toHaveAttribute("href", /preview=1/);
  });

  test("A7: manual add-form defaults the checkpoint time to NEAR the chunk end, not the chunk start", async ({ teacherPage: page, baseURL }) => {
    test.setTimeout(120_000);
    // createAnalyzedLesson seeds ONE chunk spanning 0–7s. The manual add-form must
    // default start_seconds to end−2 = 5 (same as the AI's CheckpointSecondsForChunk),
    // NOT the chunk start (0). Pre-fix it defaulted to chunk.startSeconds = 0, so a
    // manual checkpoint fired at the chunk start (== previous chunk's end) — before the
    // student had watched the chunk's content (the reported bug).
    const { lessonUrl } = await createAnalyzedLesson(baseURL);
    await page.goto(`${lessonUrl}?tab=processing`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("add-interaction-btn").first()).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("add-interaction-btn").first().click();
    const form = page.getByTestId("chunk-add-form").last();
    await expect(form).toBeVisible({ timeout: 15_000 });
    await expect(form.getByTestId("interaction-start-seconds")).toHaveValue("5");
  });

  test("A8: 'Tác vụ …' section header is STATIC (no spinner) while the task is running", async ({ teacherPage: page, baseURL }) => {
    test.setTimeout(120_000);
    // Standalone transcribe in progress → the "Tác vụ phiên âm" section is ACTIVE. Its
    // header icon must be a static dot, NOT a spinner (the hero still carries the live
    // signal). Pre-fix the active section icon was <Loader2 animate-spin> → this would fail.
    const { lessonUrl } = await seedProcessingTask({
      taskType: "transcribe",
      stage: "ANALYSIS_PROGRESS_STEP_ANALYZING",
      baseURL,
    });
    await page.goto(`${lessonUrl}?tab=processing`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("extract-progress")).toBeVisible({ timeout: 30_000 }); // task is running
    await expect(page.getByTestId("task-section-icon").first()).toBeVisible();
    // NO section-header icon may spin (the active one used to).
    await expect(page.getByTestId("task-section-icon").locator(".animate-spin")).toHaveCount(0);
  });

  test("A9: manual single-choice = radio — no auto-selected answer, only one can be correct", async ({ teacherPage: page, baseURL }) => {
    test.setTimeout(120_000);
    // Bug #4/#5: single-choice was mistaken for multiple (checkbox + auto-marked option A)
    // because the shared editor guessed by config shape and the default had correctAnswers:[].
    const { lessonUrl } = await createAnalyzedLesson(baseURL);
    await page.goto(`${lessonUrl}?tab=processing`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("add-interaction-btn").first()).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("add-interaction-btn").first().click();
    const form = page.getByTestId("chunk-add-form").last();
    await expect(form).toBeVisible({ timeout: 15_000 });
    await form.getByTestId(`interaction-kind-${InteractionKind.SINGLE_CHOICE}`).click({ force: true });

    // Shows the single-choice label, not the multiple one.
    await expect(form.getByText(/một đáp án/)).toBeVisible();
    await expect(form.getByText(/nhiều đáp án/)).toHaveCount(0);
    // #4: nothing is pre-selected as the correct answer.
    await expect(form.getByTitle("Đang là đáp án đúng")).toHaveCount(0);
    // #5: selecting A then B leaves exactly ONE correct answer (radio, not multi-tick).
    await form.getByTitle("Chọn làm đáp án đúng").first().click();
    await expect(form.getByTitle("Đang là đáp án đúng")).toHaveCount(1);
    await form.getByTitle("Chọn làm đáp án đúng").first().click();
    await expect(form.getByTitle("Đang là đáp án đúng")).toHaveCount(1);
  });

  test("A10: multiple-choice highlights ALL its correct answers in the exercise list", async ({ teacherPage: page, baseURL }) => {
    test.setTimeout(120_000);
    // Bug: the read-only list lit up only `correctAnswer` (single). Multiple stores its
    // correct options in `correctAnswers` (correctAnswer=-1) so it showed no green at all.
    const { lessonUrl, lessonId, token, chunks } = await createAnalyzedLesson(baseURL);
    // Server infers MULTIPLE_CHOICE from a non-empty correctAnswers (interactions.go).
    await createInteraction(token, lessonId, {
      prompt: "Chọn tất cả đáp án đúng",
      startSeconds: 1,
      chunkId: chunks[0]?.id,
      config: { case: "mcq", value: { question: "", options: [{ text: "A" }, { text: "B" }, { text: "C" }, { text: "D" }], correctAnswer: -1, correctAnswers: [0, 2] } },
    }, baseURL);
    await page.goto(`${lessonUrl}?tab=processing`, { waitUntil: "domcontentloaded" });
    // The chunk is collapsed on fresh load — expand it to reveal the interaction rows.
    await expect(page.getByTestId("chunk-title-bar").first()).toBeVisible({ timeout: 30_000 });
    if ((await page.getByTestId("interaction-row").count()) === 0) {
      await page.getByTestId("chunk-title-bar").first().click();
    }
    await expect(page.getByText("Trắc nghiệm nhiều đáp án").first()).toBeVisible({ timeout: 15_000 });
    const opts = page.getByTestId("mcq-list-option");
    await expect(opts).toHaveCount(4);
    // A (0) and C (2) are correct → highlighted; B (1) and D (3) are not.
    await expect(opts.nth(0)).toHaveAttribute("data-correct", "true");
    await expect(opts.nth(1)).toHaveAttribute("data-correct", "false");
    await expect(opts.nth(2)).toHaveAttribute("data-correct", "true");
    await expect(opts.nth(3)).toHaveAttribute("data-correct", "false");
  });

  // Reproduces the reported failed-transcribe bugs (#12, #13) in ONE real failure state:
  //   B: the stepper's transcript step read "Sẵn sàng" while it had actually failed.
  //   C: the sub-step checklist was ALL green (done) even though the task failed.
  //   D: two buttons with the same retry function — the hero "Thử lại" AND the
  //      "Trích xuất transcript" CTA (the earlier test only counted "Thử lại", so it
  //      never caught the CTA duplicate).
  //   E: mixed "transcript"/"phiên âm" wording — must be Vietnamese only.
  test("failed transcribe reflects the failure: error status, no all-green checklist, single retry, VN terms (B/C/D/E)", async ({ teacherPage: page, baseURL }) => {
    test.setTimeout(180_000);
    // Fresh lesson (carol owns the course → teacherPage can access it) with an INVALID
    // video, so the transcribe task fails deterministically (ffmpeg cannot extract
    // audio) — no Whisper needed.
    const { token, userId } = await getTeacherAuth(baseURL);
    const orgId = await getOrgId(token, SEED_HUST_CS_SLUG, baseURL);
    const courseId = await createCourse(token, orgId, uid("D-Course"), userId, baseURL);
    const moduleId = await createCourseModule(token, courseId, uid("D-Module"), baseURL);
    const lessonId = await createLesson(token, moduleId, uid("D-Lesson"), baseURL);
    await uploadLessonVideo(token, lessonId, { videoPath: INVALID_VIDEO, baseURL });

    await page.goto(`${lessonUrlFor(SEED_HUST_CS_SLUG, courseId, lessonId)}?tab=processing`, { waitUntil: "domcontentloaded" });

    // BUG E: the start button is Vietnamese ("phiên âm"), never English "transcript".
    await expect(page.getByRole("button", { name: /Trích xuất transcript/ })).toHaveCount(0);
    await page.getByRole("button", { name: /Trích xuất phiên âm/ }).first().click();

    // The transcribe fails → the transcript step's error hero appears with its single retry.
    await expect(page.getByTestId("extract-progress-retry")).toBeVisible({ timeout: 120_000 });

    // BUG D: exactly ONE retry action. The failed state must show the hero "Thử lại"
    // and NOT also re-show the "Trích xuất phiên âm" / "Trích xuất lại" CTA (that was
    // the reported duplicate — two buttons doing the same re-transcribe).
    await expect(page.getByRole("button", { name: "Thử lại" })).toHaveCount(1);
    await expect(page.getByRole("button", { name: /Trích xuất phiên âm|Trích xuất lại/ })).toHaveCount(0);

    // BUG C: the sub-step checklist must NOT read all-green when the task failed —
    // at least one step is in error and not every step is "done".
    const steps = page.getByTestId("stream-step");
    await expect(steps.first()).toBeVisible({ timeout: 10_000 });
    const total = await steps.count();
    await expect(page.locator('[data-testid="stream-step"][data-step-state="error"]').first()).toBeVisible();
    await expect(page.locator('[data-testid="stream-step"][data-step-state="done"]')).not.toHaveCount(total);

    // BUG B: the stepper's transcript step shows the failure, not "Sẵn sàng".
    const transcriptStep = page.getByTestId("workflow-step-transcript");
    await expect(transcriptStep).toContainText("Phiên âm thất bại");
    await expect(transcriptStep).not.toContainText("Sẵn sàng");

    // Manual-verification artifact.
    await page.screenshot({ path: "test-results/failed-transcribe-fixed.png", fullPage: true });
  });

  // Reported bug #15 (the user's exact repro): a lesson runs the pipeline SUCCESSFULLY
  // (chunks + interactions), then the audio language is changed so a RE-TRANSCRIBE
  // FAILS, and on RELOAD the stepper shows a CONTRADICTORY state — "Phân đoạn: 4 đoạn"
  // (green) sitting under a red "Phiên âm thất bại", with stale chunks from the previous
  // run. Three compounding root causes, all asserted here end-to-end:
  //   #1 RunExtract left stale chunks when the transcribe failed (returned before the
  //      cleanup) → GetLessonAnalysis still had 4 chunks.
  //   #2 deriveAnalysisFromTasks let a stale succeeded chunk task mask the failed
  //      transcribe → status CHUNKS_READY instead of ERROR.
  //   #3 the stepper derived the chunk step from raw hasChunks → "done" under a failed
  //      transcribe.
  test("bug #15: a failed re-transcribe clears stale chunks + shows a consistent state on reload", async ({ teacherPage: page, baseURL }) => {
    test.setTimeout(240_000); // a REAL re-transcribe runs Whisper
    // First run SUCCEEDED: real English video (edu-sample-en) + seeded chunks +
    // synthetic succeeded transcribe/chunk/quiz_gen tasks (lesson reads DONE).
    const { lessonUrl, lessonId, token, chunks } = await createAnalyzedLesson(baseURL);
    expect(chunks.length).toBeGreaterThan(0);

    const ai = aiClient(token);
    const storage = storageClient(token);

    // Make the next transcribe FAIL deterministically (no Whisper): OVERWRITE the video
    // object with an invalid file (ffmpeg cannot extract audio) at the SAME storage key
    // — via a presigned PUT, NOT UpdateLessonVideo — so the lesson's video pointer AND
    // the previous run's chunks are LEFT IN PLACE. That is the exact precondition of the
    // bug (chunks present, then the re-transcribe fails). It stands in for the user's
    // "đổi ngôn ngữ âm thanh để phiên âm fail": any transcribe failure over pre-existing
    // chunks triggers the same stale-state bug (a degenerate wrong-language transcript is
    // just one flavour, and is non-deterministic on a short clip).
    const videoKey = `lessons/${lessonId}/video.mp4`;
    const { uploadUrl } = await storage.getUploadUrl({ key: videoKey, contentType: "video/mp4", expiresInSeconds: 3600 });
    const putResp = await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": "video/mp4" }, body: fs.readFileSync(INVALID_VIDEO) });
    expect(putResp.ok).toBeTruthy();

    // Re-transcribe, then wait for the transcribe task to terminate as FAILED.
    await ai.startLessonTask({ lessonId, kind: LessonTaskKind.EXTRACT_TRANSCRIPT });
    await expect
      .poll(async () => {
        const { tasks } = await ai.listLessonTasks({ lessonId, activeOnly: false, limit: 50, offset: 0 });
        return tasks.some((t) => t.kind === LessonTaskKind.EXTRACT_TRANSCRIPT && t.status === LessonTaskStatus.FAILED)
          ? "failed" : "pending";
      }, { timeout: 180_000, intervals: [3000] })
      .toBe("failed");

    // ROOT #1 (data): the failed re-transcribe cleared the stale chunks — no orphans.
    // Assert via the RAW list RPC (physical rows), NOT getLessonAnalysis: the read
    // path now ALSO suppresses stale chunks on a failed transcribe, so the analysis
    // response being empty no longer proves RunExtract's up-front wipe ran. The raw
    // RPC keeps the write-path cleanup independently guarded.
    const rawChunks = await ai.listLessonTranscriptChunks({ lessonId, limit: 50, offset: 0 });
    expect(rawChunks.chunks.length).toBe(0);
    const after = await ai.getLessonAnalysis({ lessonId });
    expect(after.chunks.length).toBe(0);
    // ROOT #2 (status derivation): a failed transcribe → ERROR, not CHUNKS_READY/DONE.
    expect(after.analysis?.status).toBe(AnalysisStatus.ERROR);

    // RELOAD — the state now comes purely from the server (the real bug surface).
    await page.goto(`${lessonUrl.split("?")[0]}?tab=processing`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("video-workflow-stepper")).toBeVisible({ timeout: 20_000 });

    // ROOT #3 (display invariant): transcribe failed, and NO downstream step reads as
    // done. The chunk step is LOCKED (disabled — blocked by the failed transcribe) and
    // shows no "N đoạn" count (the title "Phân đoạn" contains "đoạn", so match a count).
    await expect(page.getByTestId("workflow-step-transcript")).toContainText("Phiên âm thất bại");
    const chunkStep = page.getByTestId("workflow-step-chunks");
    await expect(chunkStep).toBeDisabled();
    await expect(chunkStep).not.toContainText(/\d+\s*đoạn/);

    await page.screenshot({ path: "test-results/bug15-consistent-after-fix.png", fullPage: true });
  });

  // Reported bug #8 (the user's SECOND repro — the state PRE-EXISTS in the DB): a
  // lesson carries STALE chunk rows while its only task is a FAILED transcribe (rows
  // left behind by an old binary that cleaned up only on success). No write path runs
  // on a page reload, so ONLY the read path can repair the display: GetLessonAnalysis
  // must return ONE coherent view model — status ERROR with the stale artifacts
  // SUPPRESSED. Pre-fix the payload was self-contradictory (ERROR + 4 chunks) and the
  // FE faithfully rendered the garbage: a LOCKED "Phân đoạn" step still reading
  // "4 đoạn", a locked "Bài tập" reading "Sẵn sàng", the body jumping to exercises
  // ("0/4 phân đoạn / 4 trống"), and a phantom "Tác vụ thất bại" generation banner.
  test("bug #8: reload of a lesson with stale chunks + a failed transcribe renders ONE coherent failed state", async ({ teacherPage: page, baseURL }) => {
    test.setTimeout(120_000);
    const errorMsg = "phiên âm bị lặp bất thường — âm thanh có thể quá ngắn, nhiều nhạc/nhiễu, hoặc không rõ tiếng nói.";
    const { lessonId, lessonUrl, token } = await seedFailedTranscribeWithStaleChunks(baseURL, { errorMsg });
    const ai = aiClient(token);

    // RPC preconditions — the stale rows PHYSICALLY exist (raw list RPC returns
    // them); the fix is read-path suppression, not their absence…
    const raw = await ai.listLessonTranscriptChunks({ lessonId, limit: 50, offset: 0 });
    expect(raw.chunks.length).toBe(4);
    // …while the authoritative analysis view exposes NONE of them, and surfaces
    // the real failure message (not a generic fallback).
    const analysis = await ai.getLessonAnalysis({ lessonId });
    expect(analysis.analysis?.status).toBe(AnalysisStatus.ERROR);
    expect(analysis.chunks.length).toBe(0);
    expect(analysis.analysis?.interactions.length).toBe(0);
    expect(analysis.analysis?.errorMsg).toBe(errorMsg);

    // UI: a fresh load renders ONE coherent failed state.
    await page.goto(`${lessonUrl.split("?")[0]}?tab=processing`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("video-workflow-stepper")).toBeVisible({ timeout: 20_000 });

    const transcriptStep = page.getByTestId("workflow-step-transcript");
    const chunkStep = page.getByTestId("workflow-step-chunks");
    const exerciseStep = page.getByTestId("workflow-step-exercises");
    await expect(transcriptStep).toContainText("Phiên âm thất bại");
    await expect(chunkStep).toBeDisabled();
    await expect(chunkStep).toContainText("Chưa sẵn sàng");
    await expect(chunkStep).not.toContainText(/\d+\s*đoạn/); // the "4 đoạn" leak
    await expect(exerciseStep).toBeDisabled();
    await expect(exerciseStep).toContainText("Chưa tạo");
    await expect(exerciseStep).not.toContainText("Sẵn sàng");

    // The body lands on the FAILED transcribe step (error hero + ONE retry) with the
    // REAL error text — not on the exercises step with the stale "0/4 phân đoạn".
    await expect(page.getByTestId("workflow-step-body")).toContainText("Phiên âm bài giảng");
    await expect(page.getByRole("button", { name: "Thử lại" })).toHaveCount(1);
    // EXACTLY ONCE: the task panel used to re-list the current step's FAILED task
    // (its dedup only filtered ACTIVE tasks), so the same error message rendered
    // twice — in the panel row AND in the error hero (reported dup).
    await expect(page.getByText(errorMsg)).toHaveCount(1);
    // The background-task panel must not appear at all here: the failed transcribe
    // belongs to the CURRENT step (its hero owns the display) and it is the only task.
    await expect(page.getByTestId("lesson-task-panel")).toHaveCount(0);
    await expect(page.getByTestId("workflow-step-body")).not.toContainText(/0 bài tập|trống/);

    // The SUB-STEP strip must tell the truth on reload (reported bug: all four
    // sub-steps rendered green ✓ under the failed hero). Pre-fix the reload
    // initializer hardcoded failedAt=null and getStepState treated that as
    // "everything done"; the tracker's transition gate never re-attributed a task
    // that was already failed at page load. The seeded task died at ANALYZING
    // (progress_step), so the honest render is: download ✓, audio-extract ✓,
    // ANALYZING ✗, save pending — never four ✓.
    const stripSteps = page.getByTestId("stream-step");
    await expect(stripSteps).toHaveCount(4, { timeout: 10_000 });
    await expect(page.locator('[data-testid="stream-step"][data-step-state="error"]')).toHaveCount(1, { timeout: 10_000 });
    await expect(page.locator('[data-testid="stream-step"][data-step-state="error"]')).toContainText("Đang phiên âm");
    await expect(page.locator('[data-testid="stream-step"][data-step-state="done"]')).toHaveCount(2);
    await expect(page.locator('[data-testid="stream-step"][data-step-state="pending"]')).toContainText("Lưu kết quả");

    // The bug was RELOAD-specific — reload and re-assert the coherent state.
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("video-workflow-stepper")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("workflow-step-transcript")).toContainText("Phiên âm thất bại");
    await expect(page.getByTestId("workflow-step-chunks")).not.toContainText(/\d+\s*đoạn/);
    await expect(page.getByRole("button", { name: "Thử lại" })).toHaveCount(1);
    await expect(page.locator('[data-testid="stream-step"][data-step-state="error"]')).toHaveCount(1, { timeout: 10_000 });
    await expect(page.locator('[data-testid="stream-step"][data-step-state="done"]')).toHaveCount(2);

    await page.screenshot({ path: "test-results/bug8-coherent-after-fix.png", fullPage: true });
    // Element shot of the error hero + sub-step strip (the reported all-green strip).
    await page.getByTestId("extract-progress").screenshot({ path: "test-results/bug8-substeps-after-fix.png" });
  });
});
