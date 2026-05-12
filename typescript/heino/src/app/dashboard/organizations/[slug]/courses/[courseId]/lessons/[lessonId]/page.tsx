import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAnyUser, requireOrgMember } from "@/lib/auth";
import { createRichterClient } from "@/lib/connect-client";
import { OrganizationService } from "buf/gen/richter/v1/organizations_pb";
import { CourseService, LessonService, CourseModuleService } from "buf/gen/richter/v1/courses_pb";
import { StorageService } from "buf/gen/richter/v1/storage_pb";
import { OrganizationRole } from "buf/gen/richter/v1/organization_members_pb";
import { Code, ConnectError } from "@connectrpc/connect";
import { Button } from "@/components/ui/button";
import { ChevronLeftIcon, VideoIcon, PlayCircleIcon } from "lucide-react";
import { VideoUpload } from "./video-upload";

const CAN_MANAGE = [OrganizationRole.OWNER, OrganizationRole.ADMIN, OrganizationRole.TEACHER];

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

  // Get presigned download URL if video exists
  let videoUrl: string | null = null;
  if (lesson.videoStorageKey) {
    try {
      const storageClient = createRichterClient(StorageService, token);
      const res = await storageClient.getDownloadUrl({
        key: lesson.videoStorageKey,
        expiresInSeconds: 3600,
      });
      videoUrl = res.downloadUrl;
    } catch {
      // storage unavailable — degrade gracefully
    }
  }

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
          <video
            src={videoUrl}
            controls
            className="w-full h-full"
            preload="metadata"
          />
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

      {/* Teacher/admin upload controls */}
      {canManage && (
        <div className="rounded-lg border p-4 flex flex-col gap-3">
          <h2 className="font-medium text-sm">Quản lý video</h2>
          <VideoUpload
            lessonId={lesson.id}
            moduleId={lesson.moduleId}
            courseId={courseId}
            slug={slug}
            hasVideo={!!lesson.videoStorageKey}
          />
          {lesson.videoStorageKey && (
            <p className="text-xs text-muted-foreground font-mono break-all">
              Key: {lesson.videoStorageKey}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
