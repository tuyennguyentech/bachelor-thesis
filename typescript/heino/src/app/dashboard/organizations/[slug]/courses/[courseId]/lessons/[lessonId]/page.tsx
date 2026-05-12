import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAnyUser, requireOrgMember } from "@/lib/auth";
import { createRichterClient } from "@/lib/connect-client";
import { OrganizationService } from "buf/gen/richter/v1/organizations_pb";
import { CourseService, LessonService, CourseModuleService } from "buf/gen/richter/v1/courses_pb";
import { StorageService } from "buf/gen/richter/v1/storage_pb";
import { AIService } from "buf/gen/richter/v1/ai_pb";
import { AnalysisStatus } from "buf/gen/richter/v1/ai_pb";
import { OrganizationRole } from "buf/gen/richter/v1/organization_members_pb";
import { Code, ConnectError } from "@connectrpc/connect";
import { Button } from "@/components/ui/button";
import { ChevronLeftIcon, VideoIcon, PlayCircleIcon, SparklesIcon, FileTextIcon } from "lucide-react";
import { VideoUpload } from "./video-upload";
import { AnalyzeButton } from "./analyze-button";

const CAN_MANAGE = [OrganizationRole.OWNER, OrganizationRole.ADMIN, OrganizationRole.TEACHER];

function statusLabel(s: AnalysisStatus): string {
  switch (s) {
    case AnalysisStatus.PENDING: return "Chờ xử lý";
    case AnalysisStatus.PROCESSING: return "Đang xử lý…";
    case AnalysisStatus.DONE: return "Hoàn thành";
    case AnalysisStatus.ERROR: return "Lỗi";
    default: return "";
  }
}

export default async function LessonDetailPage({
  params,
}: {
  params: Promise<{ slug: string; courseId: string; lessonId: string }>;
}) {
  const { slug, courseId, lessonId } = await params;
  const { token } = await requireAnyUser();

  const orgClient = createRichterClient(OrganizationService, token);
  let org;
  try {
    const res = await orgClient.getOrganizationBySlug({ slug });
    org = res.organization;
  } catch (err) {
    if (err instanceof ConnectError && err.code === Code.NotFound) notFound();
    throw err;
  }
  if (!org) notFound();

  const { member } = await requireOrgMember(org.id);
  const canManage = CAN_MANAGE.includes(member.role);

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

  // Fetch video URL and AI analysis in parallel
  const [videoUrl, analysis] = await Promise.all([
    lesson.videoStorageKey
      ? createRichterClient(StorageService, token)
          .getDownloadUrl({ key: lesson.videoStorageKey, expiresInSeconds: 3600 })
          .then((r) => r.downloadUrl)
          .catch(() => null)
      : Promise.resolve(null),
    createRichterClient(AIService, token)
      .getLessonAnalysis({ lessonId })
      .then((r) => r.analysis ?? null)
      .catch(() => null),
  ]);

  const isDone = analysis?.status === AnalysisStatus.DONE;

  return (
    <div className="mx-auto max-w-3xl flex flex-col gap-6">
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
        <h1 className="text-xl font-semibold">{lesson.title}</h1>
        {lesson.description && (
          <p className="text-sm text-muted-foreground mt-1">{lesson.description}</p>
        )}
      </div>

      {/* Video player */}
      <div className="rounded-lg border overflow-hidden bg-black aspect-video flex items-center justify-center">
        {videoUrl ? (
          <video src={videoUrl} controls className="w-full h-full" preload="metadata" />
        ) : (
          <div className="flex flex-col items-center gap-2 text-muted-foreground p-8">
            {canManage ? (
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
        )}
      </div>

      {/* Teacher/admin: upload + analyze controls */}
      {canManage && (
        <div className="rounded-lg border p-4 flex flex-col gap-4">
          <h2 className="font-medium text-sm">Quản lý video</h2>
          <VideoUpload
            lessonId={lesson.id}
            moduleId={lesson.moduleId}
            courseId={courseId}
            slug={slug}
            hasVideo={!!lesson.videoStorageKey}
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
                <AnalyzeButton lessonId={lesson.id} slug={slug} courseId={courseId} />
                {analysis?.status === AnalysisStatus.ERROR && (
                  <p className="text-xs text-destructive">{analysis.errorMsg}</p>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {/* Transcript */}
      {isDone && analysis?.transcript && (
        <div className="rounded-lg border p-4 flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <FileTextIcon className="size-4 text-muted-foreground" />
            <h2 className="font-medium text-sm">Phiên âm nội dung</h2>
          </div>
          <p className="text-sm text-muted-foreground whitespace-pre-wrap leading-relaxed">
            {analysis.transcript}
          </p>
        </div>
      )}

      {/* MCQ Questions */}
      {isDone && analysis?.questions && analysis.questions.length > 0 && (
        <div className="rounded-lg border p-4 flex flex-col gap-4">
          <div className="flex items-center gap-2">
            <SparklesIcon className="size-4 text-muted-foreground" />
            <h2 className="font-medium text-sm">
              Câu hỏi trắc nghiệm ({analysis.questions.length} câu)
            </h2>
          </div>
          <div className="flex flex-col gap-6">
            {analysis.questions.map((q, qi) => (
              <div key={q.id} className="flex flex-col gap-2">
                <p className="text-sm font-medium">
                  {qi + 1}. {q.questionText}
                </p>
                <div className="grid grid-cols-1 gap-1 ml-4">
                  {q.options.map((opt, oi) => (
                    <div
                      key={oi}
                      className={`text-sm px-3 py-1.5 rounded-md border ${
                        oi === q.correctAnswer
                          ? "border-green-500 bg-green-50 dark:bg-green-950/30 text-green-700 dark:text-green-400"
                          : "border-transparent text-muted-foreground"
                      }`}
                    >
                      {String.fromCharCode(65 + oi)}. {opt.text}
                    </div>
                  ))}
                </div>
                {q.explanation && (
                  <p className="text-xs text-muted-foreground ml-4 italic">{q.explanation}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
