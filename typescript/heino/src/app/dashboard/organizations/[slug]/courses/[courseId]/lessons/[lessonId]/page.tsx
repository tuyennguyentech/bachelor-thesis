import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAnyUser, requireOrgMember } from "@/lib/auth";
import { createRichterClient } from "@/lib/connect-client";
import { OrganizationService } from "buf/gen/richter/v1/organizations_pb";
import { CourseService, LessonService, CourseModuleService } from "buf/gen/richter/v1/courses_pb";
import { StorageService } from "buf/gen/richter/v1/storage_pb";
import { AIService, AnalysisStatus } from "buf/gen/richter/v1/ai_pb";
import { InteractionService, FeedbackMode } from "buf/gen/richter/v1/interactions_pb";
import { OrganizationRole } from "buf/gen/richter/v1/organization_members_pb";
import { Code, ConnectError } from "@connectrpc/connect";
import { Button } from "@/components/ui/button";
import {
  ChevronLeftIcon,
  VideoIcon,
  PlayCircleIcon,
  SparklesIcon,
  UsersIcon,
  EyeIcon,
} from "lucide-react";
import { VideoUpload } from "./video-upload";
import { AnalyzeButton } from "./analyze-button";
import { LessonAttempts } from "./lesson-attempts";
import { VideoPlayer } from "./video-player";
import { StudentLessonView } from "./student-lesson-view";
import { extractLocalResponse } from "@/interactions/registry";

const CAN_MANAGE = [OrganizationRole.OWNER, OrganizationRole.ADMIN, OrganizationRole.TEACHER];

function statusLabel(s: AnalysisStatus): string {
  switch (s) {
    case AnalysisStatus.PENDING: return "Chờ xử lý";
    case AnalysisStatus.PROCESSING: return "Đang xử lý…";
    case AnalysisStatus.TRANSCRIPT_EXTRACTED: return "Đã trích xuất";
    case AnalysisStatus.CHUNKS_READY: return "Đã phân đoạn";
    case AnalysisStatus.DONE: return "Hoàn thành";
    case AnalysisStatus.ERROR: return "Lỗi";
    default: return "";
  }
}

export default async function LessonDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; courseId: string; lessonId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug, courseId, lessonId } = await params;
  const { token } = await requireAnyUser();

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
  const isPreview = sp.preview === "1" && canManage;
  const effectiveCanManage = canManage && !isPreview;

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

  const interactionClient = createRichterClient(InteractionService, token);
  const aiClient = createRichterClient(AIService, token);

  // Parallel fetches: video URL, AI analysis, my attempt, teacher attempts list, watch progress
  const [videoUrl, analysisRes, myAttempt, attemptsData, initialPosition] = await Promise.all([
    lesson.videoStorageKey
      ? createRichterClient(StorageService, token)
          .getDownloadUrl({ key: lesson.videoStorageKey, expiresInSeconds: 3600 })
          .then((r) => r.downloadUrl)
          .catch(() => null)
      : Promise.resolve(null),
    aiClient
      .getLessonAnalysis({ lessonId })
      .then((r) => ({ analysis: r.analysis ?? null, chunks: r.chunks }))
      .catch(() => ({ analysis: null, chunks: [] })),
    effectiveCanManage
      ? Promise.resolve(null)
      : interactionClient
          .getMyAttempt({ lessonId })
          .then((r) => r.attempt ?? null)
          .catch(() => null),
    effectiveCanManage
      ? interactionClient
          .listAttempts({ lessonId, limit: 50, offset: 0 })
          .then((r) => ({ attempts: r.attempts, total: r.total }))
          .catch(() => ({ attempts: [], total: 0 }))
      : Promise.resolve(null),
    lesson.videoStorageKey
      ? aiClient.getWatchProgress({ lessonId }).then((r) => r.positionSeconds ?? 0).catch(() => 0)
      : Promise.resolve(0),
  ]);

  const { analysis, chunks: initialChunks } = analysisRes;

  const isDone = analysis?.status === AnalysisStatus.DONE;
  // Pass LessonInteraction[] directly — server already strips correctAnswer per feedbackMode.
  const interactions = isDone ? (analysis?.interactions ?? []) : [];

  // Build previous result from student's attempt (if any).
  const previousResult = myAttempt
    ? {
        totalScore: myAttempt.totalScore,
        maxScore: myAttempt.maxScore,
        responses: myAttempt.responses.map((r) => ({
          interactionId: r.interactionId,
          response: extractLocalResponse(r),
          score: r.score,
          maxScore: r.maxScore,
        })),
      }
    : null;

  return (
    <div className="mx-auto w-full max-w-screen-2xl px-4 lg:px-6 flex flex-col gap-6">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" asChild className="gap-1">
          <Link href={`/dashboard/organizations/${slug}/courses/${courseId}`}>
            <ChevronLeftIcon className="size-4" />
            {course.title}
          </Link>
        </Button>
      </div>

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
            <span>⏱ ~{Math.ceil(lesson.durationSeconds / 60)} phút</span>
          ) : null}
          {lesson.durationSeconds && interactions.length > 0 ? <span>·</span> : null}
          {interactions.length > 0 && (
            <span>📝 {interactions.length} câu hỏi</span>
          )}
          {interactions.length > 0 && (
            <>
              <span>·</span>
              <span>{previousResult ? "🎯 đã hoàn thành" : "🎯 chưa hoàn thành"}</span>
            </>
          )}
        </div>
      </div>

      {/* Preview banner */}
      {isPreview && (
        <div className="flex items-center justify-between rounded-lg border border-yellow-300 bg-yellow-50 dark:bg-yellow-950/20 px-4 py-2 text-sm">
          <span className="text-yellow-800 dark:text-yellow-300 font-medium">Đang xem thử dưới dạng học viên</span>
          <Link href="?">
            <Button variant="outline" size="sm" className="gap-1.5 text-xs border-yellow-400 text-yellow-800 hover:bg-yellow-100 dark:text-yellow-300 dark:border-yellow-600 dark:hover:bg-yellow-900/30">
              <EyeIcon className="size-3.5" />
              Thoát xem thử
            </Button>
          </Link>
        </div>
      )}

      {/* Video player (+ checkpoint-driven quiz flow for students) */}
      {videoUrl ? (
        !effectiveCanManage || isPreview ? (
          <StudentLessonView
            videoUrl={videoUrl}
            segments={analysis?.transcriptSegments ?? []}
            transcript={analysis?.transcript ?? ""}
            chunks={initialChunks}
            lessonId={lessonId}
            initialPosition={initialPosition}
            initialDuration={lesson.durationSeconds ?? 0}
            token={token}
            interactions={interactions}
            previousResult={isPreview ? null : previousResult}
            feedbackMode={lesson.feedbackMode ?? FeedbackMode.AFTER_SUBMIT}
            isPreview={isPreview}
          />
        ) : (
          <VideoPlayer
            videoUrl={videoUrl}
            segments={analysis?.transcriptSegments ?? []}
            transcript={analysis?.transcript ?? ""}
            lessonId={lessonId}
            initialPosition={initialPosition}
            token={token}
          />
        )
      ) : (
        <div className="rounded-lg border overflow-hidden bg-black aspect-video flex items-center justify-center">
          <div className="flex flex-col items-center gap-2 text-muted-foreground p-8">
            {effectiveCanManage ? (
              <>
                <VideoIcon className="size-10 opacity-30" />
                <p className="text-sm">Chưa có video. Tải video lên bên dưới.</p>
              </>
            ) : (
              <>
                <PlayCircleIcon className="size-10 opacity-30" />
                <p className="text-sm">Nội dung chưa được cung cấp.</p>
              </>
            )}
          </div>
        </div>
      )}

      {/* Teacher/admin: upload + analyze controls — hidden in preview */}
      {canManage && !isPreview && (
        <div className="rounded-lg border p-4 flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <h2 className="font-medium text-sm">Quản lý video</h2>
            {!isPreview && (
              <Link href="?preview=1">
                <Button variant="ghost" size="sm" className="gap-1.5 text-xs">
                  <EyeIcon className="size-3.5" />
                  Xem thử
                </Button>
              </Link>
            )}
          </div>
          {effectiveCanManage && (
            <>
              <VideoUpload
                lessonId={lesson.id}
                moduleId={lesson.moduleId}
                courseId={courseId}
                slug={slug}
                hasVideo={!!lesson.videoStorageKey}
                token={token}
              />
              {lesson.videoStorageKey && (
                <>
                  <p className="text-xs text-muted-foreground font-mono break-all">
                    Key: {lesson.videoStorageKey}
                  </p>
                  <div className="border-t pt-3 flex flex-col gap-2">
                    <div className="flex items-center gap-2">
                      <SparklesIcon className="size-4 text-muted-foreground" />
                      <span className="text-sm font-medium">AI Phân tích</span>
                      {analysis && (
                        <span className="text-xs text-muted-foreground">
                          ({statusLabel(analysis.status)})
                        </span>
                      )}
                    </div>
                    <AnalyzeButton
                      key={lesson.videoStorageKey ?? "no-video"}
                      lessonId={lesson.id}
                      initialChunks={initialChunks}
                      initialSegments={analysis?.transcriptSegments ?? []}
                      initialStatus={analysis?.status}
                      initialInteractions={analysis?.interactions ?? []}
                      initialFeedbackMode={lesson.feedbackMode ?? FeedbackMode.AFTER_SUBMIT}
                      token={token}
                    />
                    {analysis?.status === AnalysisStatus.ERROR && (
                      <p className="text-xs text-destructive">{analysis.errorMsg}</p>
                    )}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      )}

      {/* Teacher/admin: student progress */}
      {effectiveCanManage && attemptsData && (
        <div className="rounded-lg border p-4 flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <UsersIcon className="size-4 text-muted-foreground" />
            <h2 className="font-medium text-sm">Tiến độ học viên</h2>
          </div>
          <LessonAttempts attempts={attemptsData.attempts} total={attemptsData.total} />
        </div>
      )}
    </div>
  );
}
