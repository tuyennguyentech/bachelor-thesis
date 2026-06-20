import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAnyUser, requireOrgMember } from "@/lib/auth";
import { createRichterClient } from "@/lib/connect-client";
import { OrganizationService } from "buf/gen/richter/v1/organizations_pb";
import {
  CourseService,
  LessonService,
  CourseModuleService,
  type Lesson,
} from "buf/gen/richter/v1/courses_pb";
import { StorageService } from "buf/gen/richter/v1/storage_pb";
import { AIService } from "buf/gen/richter/v1/ai_pb";
import { InteractionService, FeedbackMode } from "buf/gen/richter/v1/interactions_pb";
import { OrganizationRole } from "buf/gen/richter/v1/organization_members_pb";
import { Code, ConnectError } from "@connectrpc/connect";
import { Button } from "@/components/ui/button";
import { ModeToggle } from "@/components/mode-toggle";
import { logout } from "@/app/actions/auth";
import {
  ChevronLeftIcon,
  VideoIcon,
  PlayCircleIcon,
  SparklesIcon,
  BarChart2Icon,
  EyeIcon,
  BuildingIcon,
  LogOutIcon,
} from "lucide-react";
import { AnalyzeButton } from "./analyze-button";
import { LessonAttempts, NeedsAttentionBand, QuestionAnalysis } from "./lesson-attempts";
import { LessonHeatmap } from "./lesson-heatmap";
import { LessonResultsTabs, type ResultsSubTab } from "./lesson-results-tabs";
import { VideoPlayer } from "./video-player";
import { StudentLessonView } from "./student-lesson-view";
import { extractLocalResponse } from "@/interactions/registry";
import { RecentAccessRecorder } from "@/components/dashboard/recent-access-recorder";
import { QuickCreateTrigger } from "@/components/dashboard/quick-create/QuickCreateTrigger";
import { LessonCourseSidebar, LessonWorkspaceShell } from "./lesson-workspace";
import { LessonTeacherTabs, SwitchToProcessingButton, type TeacherTab } from "./lesson-teacher-tabs";
import { LessonAnalysisLiveProvider } from "./lesson-analysis-live-context";

const CAN_MANAGE = [OrganizationRole.OWNER, OrganizationRole.ADMIN, OrganizationRole.TEACHER];
const COURSE_NAV_LIMIT = 100;

/**
 * Normalise the `?tab=` query param. Maps the legacy `"exercises"` tab to
 * `"processing"`, and falls back to `"content"` for any unknown value so an
 * invalid tab never renders a blank body.
 */
function normalizeTab(raw: string | undefined): TeacherTab {
  if (raw === "exercises") return "processing";
  if (raw === "processing" || raw === "results") return raw;
  return "content";
}

/**
 * Append `#t=0.1` to a presigned video URL so the browser renders the first
 * frame as a poster instead of a black box. Only applied when the URL has no
 * existing `#` fragment (presigned URLs put their query in the search string).
 *
 * IMPORTANT: skip the fragment when we have a resume position
 * (`initialPosition > 0`). The `#t=0.1` media-fragment makes the browser seek
 * to 0.1s on metadata load, which RACES the player's resume-seek to
 * `initialPosition` — the two interleave and the video jumps erratically past
 * the intended resume point / first chunk. With no resume, the fragment is
 * harmless (and useful as a poster).
 */
function withFirstFramePoster(url: string, initialPosition = 0): string {
  if (initialPosition > 0) return url;
  return url.includes("#") ? url : `${url}#t=0.1`;
}

async function getVideoUrl(key: string, token: string): Promise<string | null> {
  try {
    const client = createRichterClient(StorageService, token);
    const res = await client.getDownloadUrl({ key, expiresInSeconds: 3600 });
    return res.downloadUrl || null;
  } catch (err) {
    console.error("[lesson/page] getDownloadUrl failed:", err);
    return null;
  }
}

function timestampVersion(ts: Lesson["updatedAt"]): string {
  if (!ts) return "";
  return `${ts.seconds}:${ts.nanos}`;
}

export default async function LessonDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; courseId: string; lessonId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug, courseId, lessonId } = await params;
  const { claims, token } = await requireAnyUser();

  const orgClient = createRichterClient(OrganizationService, token);
  let org;
  try {
    const res = await orgClient.getOrganizationBySlug({ slug });
    org = res.organization;
  } catch (err) {
    if (err instanceof ConnectError && (err.code === Code.NotFound || err.code === Code.PermissionDenied)) notFound();
    throw err;
  }
  if (!org) notFound();

  const { member } = await requireOrgMember(org.id);
  const canManage = CAN_MANAGE.includes(member.role);

  const sp = await searchParams;
  // Course-level "Vào học" signal threaded from the course page. A manager in
  // learn mode is treated as a REAL student here: they get the StudentLessonView
  // (not the Studio) AND their attempts persist (NOT a preview). This is the key
  // distinction from `?preview=1`, which is a non-persisted quick peek that lives
  // inside the Studio (preview === "1" gates off ALL persistence in
  // StudentLessonView). `mode=learn` takes precedence: a manager who chose to
  // learn never enters preview.
  const learnMode = sp.mode === "learn" && canManage;
  const isPreview = !learnMode && sp.preview === "1" && canManage;
  // A manager in learn mode renders the student player AND persists attempts:
  // not effectiveCanManage (no Studio) and not isPreview (so submit is saved).
  const effectiveCanManage = canManage && !isPreview && !learnMode;
  const activeTab = normalizeTab(typeof sp.tab === "string" ? sp.tab : undefined);
  const resultsSub: ResultsSubTab =
    sp.sub === "heatmap" || sp.sub === "questions" ? sp.sub : "table";

  const courseClient = createRichterClient(CourseService, token);
  let course;
  try {
    const res = await courseClient.getCourseById({ id: courseId });
    course = res.course;
  } catch {
    notFound();
  }
  if (!course || course.organizationId !== org.id) notFound();

  const lessonClient = createRichterClient(LessonService, token);
  let lesson;
  try {
    const res = await lessonClient.getLessonById({ id: lessonId });
    lesson = res.lesson;
  } catch {
    notFound();
  }
  if (!lesson) notFound();

  const moduleClient = createRichterClient(CourseModuleService, token);
  let module_;
  try {
    const res = await moduleClient.getCourseModuleById({ id: lesson.moduleId });
    module_ = res.module;
  } catch {
    notFound();
  }
  if (!module_ || module_.courseId !== courseId) notFound();

  const [{ modules: courseModules }, { lessons: courseLessons }] = await Promise.all([
    moduleClient
      .listCourseModules({ courseId, limit: COURSE_NAV_LIMIT, offset: 0 })
      .catch((err) => {
        console.error("[lesson/page] listCourseModules failed:", err);
        return { modules: [] };
      }),
    lessonClient
      .listLessonsByCourse({ courseId, limit: COURSE_NAV_LIMIT, offset: 0 })
      .catch((err) => {
        console.error("[lesson/page] listLessonsByCourse failed:", err);
        return { lessons: [] };
      }),
  ]);

  const interactionClient = createRichterClient(InteractionService, token);
  const aiClient = createRichterClient(AIService, token);
  const videoVersion = timestampVersion(lesson.updatedAt);

  // Parallel fetches: video URL, AI analysis, my attempt, teacher attempts list, watch progress.
  // Each non-critical call logs to console so a real RPC failure is visible in dev tools
  // instead of being silently replaced with an empty value.
  const [videoUrl, analysisRes, myAttempt, attemptsData, initialPosition, heatmapData, questionAnalytics] = await Promise.all([
    lesson.videoStorageKey
      ? getVideoUrl(lesson.videoStorageKey, token)
      : Promise.resolve(null),
    aiClient
      .getLessonAnalysis({ lessonId })
      .then((r) => ({ analysis: r.analysis ?? null, chunks: r.chunks }))
      .catch((err) => {
        console.error("[lesson/page] getLessonAnalysis failed:", err);
        return { analysis: null, chunks: [] };
      }),
    effectiveCanManage
      ? Promise.resolve(null)
      : interactionClient
          .getMyAttempt({ lessonId })
          .then((r) => r.attempt ?? null)
          .catch((err) => {
            console.error("[lesson/page] getMyAttempt failed:", err);
            return null;
          }),
    effectiveCanManage
      ? interactionClient
          .listAttempts({ lessonId, limit: 50, offset: 0 })
          .then((r) => ({ attempts: r.attempts, total: r.total }))
          .catch((err) => {
            console.error("[lesson/page] listAttempts failed:", err);
            return { attempts: [], total: 0 };
          })
      : Promise.resolve(null),
    lesson.videoStorageKey
      ? aiClient
          .getWatchProgress({ lessonId })
          .then((r) => r.positionSeconds ?? 0)
          .catch((err) => {
            console.error("[lesson/page] getWatchProgress failed:", err);
            return 0;
          })
      : Promise.resolve(0),
    effectiveCanManage
      ? interactionClient
          .lessonHeatmap({ lessonId })
          .then((r) => ({ cells: r.cells, breakdowns: r.breakdowns, error: false }))
          .catch((err) => {
            console.error("[lesson/page] lessonHeatmap failed:", err);
            return { cells: [], breakdowns: [], error: true };
          })
      : Promise.resolve(null),
    effectiveCanManage
      ? interactionClient
          .getLessonQuestionAnalytics({ lessonId })
          .then((r) => ({ kindAccuracy: r.kindAccuracy, questionStats: r.questionStats }))
          .catch((err) => {
            console.error("[lesson/page] getLessonQuestionAnalytics failed:", err);
            return { kindAccuracy: [], questionStats: [] };
          })
      : Promise.resolve(null),
  ]);

  const { analysis, chunks: initialChunks } = analysisRes;

  // Pass LessonInteraction[] directly. Per-chunk/manual generation can create
  // valid interactions while the pipeline status is still CHUNKS_READY.
  // The backend clears stale interactions when a video is replaced.
  const interactions = analysis?.interactions ?? [];

  // Build previous result from student's attempt (if any).
  const previousResult = myAttempt
    ? {
        totalScore: myAttempt.totalScore,
        maxScore: myAttempt.maxScore,
        attemptCount: myAttempt.attemptCount,
        responses: myAttempt.responses.map((r) => ({
          interactionId: r.interactionId,
          response: extractLocalResponse(r),
          score: r.score,
          maxScore: r.maxScore,
          feedback: r.feedback,
        })),
      }
    : null;

  // Compute the href to the lesson following the current one, walking the
  // course in display order (modules by orderIndex, then lessons by orderIndex).
  // `undefined` when the current lesson is the last in the course.
  const orderedLessons = [...courseModules]
    .sort((a, b) => a.orderIndex - b.orderIndex)
    .flatMap((m) =>
      courseLessons
        .filter((l) => l.moduleId === m.id)
        .sort((a, b) => a.orderIndex - b.orderIndex),
    );
  const currentIndex = orderedLessons.findIndex((l) => l.id === lessonId);
  const nextLesson =
    currentIndex >= 0 ? orderedLessons[currentIndex + 1] : undefined;
  // Keep the manager in learn mode as they advance through lessons / go back.
  const learnSuffix = learnMode ? "?mode=learn" : "";
  const nextLessonHref = nextLesson
    ? `/dashboard/organizations/${slug}/courses/${courseId}/lessons/${nextLesson.id}${learnSuffix}`
    : undefined;
  const backToCourseHref = `/dashboard/organizations/${slug}/courses/${courseId}${learnMode ? "?mode=learn" : ""}`;

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      <RecentAccessRecorder
        exactPath
        entry={{
          userId: claims.sub,
          id: `lesson:${lesson.id}`,
          type: "lesson",
          orgSlug: slug,
          title: lesson.title,
          subtitle: `${course.title} · ${org.name}`,
          href: `/dashboard/organizations/${slug}/courses/${courseId}/lessons/${lesson.id}`,
        }}
      />

      <header className="flex h-14 shrink-0 items-center justify-between border-b bg-card px-4 lg:px-6 z-10">
        <div className="flex min-w-0 items-center gap-3">
          <Button variant="ghost" size="sm" asChild className="gap-1 px-2">
            <Link href={backToCourseHref}>
              <ChevronLeftIcon className="size-4" />
              <span className="hidden sm:inline">Khóa học</span>
            </Link>
          </Button>
          <div className="hidden h-5 w-px bg-border sm:block" />
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <BuildingIcon className="size-3.5 text-muted-foreground" />
              <span>{org.name}</span>
              <span>›</span>
              <span className="truncate max-w-[150px] inline-block">{course.title}</span>
            </div>
            <p className="truncate text-sm font-semibold">{lesson.title}</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <ModeToggle />
          <form action={logout}>
            <Button variant="ghost" size="sm" type="submit" className="gap-2">
              <LogOutIcon className="size-4" />
              <span className="hidden sm:inline">Đăng xuất</span>
            </Button>
          </form>
        </div>
      </header>

      <div className="flex-1 min-h-0 overflow-auto p-4 lg:p-6">
        <div className="mx-auto w-full max-w-screen-2xl">
          <LessonWorkspaceShell
            storageKey={`dyadia_lesson_workspace_sidebar:${claims.sub}:${courseId}`}
            sidebar={
              <LessonCourseSidebar
                slug={slug}
                courseId={courseId}
                courseTitle={course.title}
                currentLessonId={lessonId}
                modules={courseModules}
                lessons={courseLessons}
                mode={learnMode ? "learn" : "manage"}
              />
            }
          >
            <div className="flex flex-col gap-6">
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2 text-muted-foreground text-xs">
                  <span>{module_.title}</span>
                  <span>›</span>
                  <span>Bài {lesson.orderIndex + 1}</span>
                </div>
                <h1 className="text-2xl font-bold tracking-tight">{lesson.title}</h1>
                {lesson.description && (
                  <p className="text-sm text-muted-foreground mt-1">{lesson.description}</p>
                )}
                <div className="flex items-center gap-3 text-sm text-muted-foreground mt-1">
                  {lesson.durationSeconds ? (
                    <span>~{Math.ceil(lesson.durationSeconds / 60)} phút</span>
                  ) : null}
                  {lesson.durationSeconds && interactions.length > 0 ? <span>·</span> : null}
                  {interactions.length > 0 && (
                    <span>{interactions.length} câu hỏi</span>
                  )}
                  {/* Completion status is a LEARNER signal. A manager (manage or
                      preview mode) never loads a personal attempt, so they'd always
                      see a misleading "Chưa hoàn thành" — hide it for them. */}
                  {interactions.length > 0 && !effectiveCanManage && !isPreview && (
                    <>
                      <span>·</span>
                      <span>{previousResult ? "Đã hoàn thành" : "Chưa hoàn thành"}</span>
                    </>
                  )}
                </div>
              </div>

              {/* Learn-mode banner: manager doing REAL persisted learning. */}
              {learnMode && (
                <div
                  data-testid="lesson-learn-banner"
                  className="flex items-center justify-between rounded-md border border-emerald-300 bg-emerald-50 dark:bg-emerald-950/20 px-4 py-2 text-sm"
                >
                  <span className="font-medium text-emerald-800 dark:text-emerald-300">
                    Bạn đang học khóa học này. Kết quả làm bài được lưu lại như học viên thật.
                  </span>
                  <Link href="?">
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5 text-xs border-emerald-400 text-emerald-800 hover:bg-emerald-100 dark:text-emerald-300 dark:border-emerald-600 dark:hover:bg-emerald-900/30"
                    >
                      Quay lại Studio
                    </Button>
                  </Link>
                </div>
              )}

              {/* Preview banner */}
              {isPreview && (
                <div className="flex items-center justify-between rounded-md border border-yellow-300 bg-yellow-50 dark:bg-yellow-950/20 px-4 py-2 text-sm">
                  <span className="text-yellow-800 dark:text-yellow-300 font-medium">Đang xem thử dưới dạng học viên</span>
                  <Link href="?">
                    <Button variant="outline" size="sm" className="gap-1.5 text-xs border-yellow-400 text-yellow-800 hover:bg-yellow-100 dark:text-yellow-300 dark:border-yellow-600 dark:hover:bg-yellow-900/30">
                      <EyeIcon className="size-3.5" />
                      Thoát xem thử
                    </Button>
                  </Link>
                </div>
              )}

              {/* Main content areas based on user role and selected tab */}
              {!effectiveCanManage || isPreview ? (
                // STUDENT or PREVIEW VIEW:
                videoUrl ? (
                  <StudentLessonView
                    key={`${isPreview ? "preview" : "student"}:${lesson.id}:${lesson.videoStorageKey}:${videoVersion}`}
                    videoUrl={withFirstFramePoster(videoUrl, isPreview ? 0 : initialPosition)}
                    videoStorageKey={lesson.videoStorageKey || undefined}
                    nextLessonHref={nextLessonHref}
                    segments={analysis?.transcriptSegments ?? []}
                    transcript={analysis?.transcript ?? ""}
                    chunks={initialChunks}
                    lessonId={lessonId}
                    initialPosition={isPreview ? 0 : initialPosition}
                    token={token}
                    interactions={interactions}
                    previousResult={isPreview ? null : previousResult}
                    feedbackMode={lesson.feedbackMode ?? FeedbackMode.AFTER_SUBMIT}
                    isPreview={isPreview}
                    maxAttempts={lesson.maxAttempts}
                  />
                ) : (
                  <div className="rounded-md border overflow-hidden bg-black aspect-video flex items-center justify-center">
                    <div className="flex flex-col items-center gap-2 text-muted-foreground p-8">
                      <PlayCircleIcon className="size-10 opacity-30" />
                      <p className="text-sm">Nội dung chưa được cung cấp.</p>
                    </div>
                  </div>
                )
              ) : (
                // TEACHER or ADMIN VIEW — three tabs, switched CLIENT-side (no
                // per-tab server re-render — see LessonTeacherTabs). The live
                // provider bridges the processing tab's freshly-run transcript to
                // the content tab's VideoPlayer without a router.refresh.
                <LessonAnalysisLiveProvider
                  initialSegments={analysis?.transcriptSegments ?? []}
                  initialTranscript={analysis?.transcript ?? ""}
                >
                <LessonTeacherTabs
                  initialTab={activeTab}
                  resultsTotal={attemptsData?.total ?? 0}
                  content={
                    <section className="w-full overflow-hidden rounded-md border bg-card shadow-sm">
                      <div className="flex items-center justify-between gap-3 border-b px-4 py-3 bg-muted/15">
                        <div className="flex min-w-0 items-center gap-2">
                          <VideoIcon className="size-4 shrink-0 text-primary" />
                          <h2 className="truncate text-sm font-semibold tracking-tight">Studio bài giảng</h2>
                        </div>
                        {lesson.videoStorageKey && (
                          <Button asChild variant="outline" size="sm" className="gap-1.5 text-xs hover:bg-muted/70 shadow-sm">
                            <Link href="?preview=1">
                              <EyeIcon className="size-3.5" />
                              Chế độ học viên
                            </Link>
                          </Button>
                        )}
                      </div>
                      {videoUrl ? (
                        <div className="p-4 flex flex-col gap-4">
                          <VideoPlayer
                            key={`${lesson.id}:${lesson.videoStorageKey}:${videoVersion}`}
                            videoUrl={withFirstFramePoster(videoUrl, initialPosition)}
                            segments={analysis?.transcriptSegments ?? []}
                            transcript={analysis?.transcript ?? ""}
                            lessonId={lessonId}
                            initialPosition={initialPosition}
                            token={token}
                            videoStorageKey={lesson.videoStorageKey ? `${lesson.videoStorageKey}:${videoVersion}` : undefined}
                            allowNativeFullscreen={true}
                            interactions={interactions}
                          />
                        </div>
                      ) : (
                        <div className="flex aspect-video items-center justify-center bg-black/95">
                          <div className="flex flex-col items-center gap-3 p-8 text-center text-muted-foreground/80">
                            <div className="rounded-full bg-muted/10 p-4 border border-border/20">
                              <VideoIcon className="size-10 opacity-40 text-primary" />
                            </div>
                            <p className="text-sm font-semibold text-foreground/90">Chưa có video. Tải video lên để bắt đầu tạo nội dung.</p>
                            <p className="text-xs text-muted-foreground max-w-[300px]">
                              Chọn <strong>Tạo nhanh</strong> để tải video + tự động chạy toàn bộ
                              quy trình, hoặc tự xử lý từng bước thủ công.
                            </p>
                            <div className="flex flex-wrap items-center justify-center gap-2 mt-1">
                              <QuickCreateTrigger
                                token={token}
                                modules={[]}
                                courseId={courseId}
                                slug={slug}
                                existingLesson={{ id: lesson.id, title: lesson.title }}
                                label="Tạo nhanh (tự động)"
                              />
                              {/* Pure client tab-switch (no navigation) — see
                                  SwitchToProcessingButton. On the always-black video
                                  placeholder a theme `outline` button is dark-on-black in
                                  light mode, so force a glassy light-on-dark treatment to
                                  stay legible in both themes. */}
                              <SwitchToProcessingButton className="gap-1.5 border-white/30 bg-white/10 text-white hover:bg-white/20 hover:text-white">
                                <SparklesIcon className="size-3.5" />
                                Xử lý thủ công
                              </SwitchToProcessingButton>
                            </div>
                          </div>
                        </div>
                      )}
                    </section>
                  }
                  processing={
                    <section className="rounded-md border bg-card p-5 shadow-sm">
                      <div className="mb-4 flex items-start gap-2.5">
                        <div className="rounded-lg bg-primary/10 p-2 text-primary">
                          <SparklesIcon className="size-4" />
                        </div>
                        <div>
                          <h2 className="text-sm font-semibold tracking-tight">Tạo nội dung từ video</h2>
                          <p className="mt-0.5 text-xs text-muted-foreground/90">
                            Phiên âm, phân đoạn và tạo bài tập trong một luồng xử lý liền mạch.
                          </p>
                        </div>
                      </div>
                      <div className="border-t border-border/40 pt-4">
                        <AnalyzeButton
                          key={`${lesson.id}:${lesson.videoStorageKey ?? "no-video"}:${videoVersion}`}
                          lessonId={lesson.id}
                          initialChunks={initialChunks}
                          initialSegments={analysis?.transcriptSegments ?? []}
                          initialTranscript={analysis?.transcript ?? ""}
                          initialStatus={analysis?.status}
                          initialErrorMsg={analysis?.errorMsg}
                          initialInteractions={analysis?.interactions ?? []}
                          initialFeedbackMode={lesson.feedbackMode ?? FeedbackMode.AFTER_SUBMIT}
                          initialDefaultInteractionConfig={analysis?.defaultInteractionConfig}
                          initialLanguage={lesson.language || "vi"}
                          initialAudioLanguage={lesson.audioLanguage}
                          initialMaxAttempts={lesson.maxAttempts}
                          title={lesson.title}
                          description={lesson.description}
                          orderIndex={lesson.orderIndex}
                          token={token}
                          videoStorageKey={lesson.videoStorageKey || undefined}
                          moduleId={lesson.moduleId}
                          courseId={courseId}
                          slug={slug}
                        />
                      </div>
                    </section>
                  }
                  results={
                    attemptsData ? (
                      <LessonResultsTabs
                        initialSub={resultsSub}
                        banner={
                          attemptsData.attempts.length > 0 ? (
                            <NeedsAttentionBand
                              attempts={attemptsData.attempts}
                              questions={questionAnalytics?.questionStats ?? []}
                            />
                          ) : null
                        }
                        table={
                          <div data-testid="lesson-attempts" className="rounded-md border p-4 flex flex-col gap-3">
                            <div className="flex items-center gap-2">
                              <BarChart2Icon className="size-4 text-muted-foreground" />
                              <h2 className="font-medium text-sm">Bảng kết quả học viên</h2>
                            </div>
                            <LessonAttempts
                              attempts={attemptsData.attempts}
                              total={attemptsData.total}
                              maxAttempts={lesson.maxAttempts}
                            />
                          </div>
                        }
                        heatmap={
                          heatmapData ? (
                            <div className="rounded-md border p-4 flex flex-col gap-3" data-testid="lesson-heatmap-panel">
                              <LessonHeatmap
                                cells={heatmapData.cells}
                                breakdowns={heatmapData.breakdowns}
                                questions={questionAnalytics?.questionStats}
                                error={heatmapData.error}
                              />
                            </div>
                          ) : (
                            <div className="rounded-md border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
                              Chưa có dữ liệu bản đồ nhiệt.
                            </div>
                          )
                        }
                        questions={
                          <QuestionAnalysis
                            perKind={questionAnalytics?.kindAccuracy}
                            questions={questionAnalytics?.questionStats}
                          />
                        }
                      />
                    ) : null
                  }
                />
                </LessonAnalysisLiveProvider>
              )}
            </div>
          </LessonWorkspaceShell>
        </div>
      </div>
    </div>
  );
}
