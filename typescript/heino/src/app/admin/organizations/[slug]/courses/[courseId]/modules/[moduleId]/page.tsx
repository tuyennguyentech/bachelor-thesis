import { requireAdmin } from "@/lib/auth";
import { createRichterClient } from "@/lib/connect-client";
import { OrganizationService } from "buf/gen/richter/v1/organizations_pb";
import { CourseService, CourseModuleService, LessonService } from "buf/gen/richter/v1/courses_pb";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { BookOpenIcon, ChevronLeftIcon, PlaySquareIcon } from "lucide-react";
import { notFound } from "next/navigation";
import { AddLessonDialog } from "./add-lesson-dialog";
import { LessonActions } from "./lesson-actions";
import { Breadcrumbs } from "@/components/ui/breadcrumbs";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { RecentAccessRecorder } from "@/components/dashboard/recent-access-recorder";

export default async function ModuleDetailPage({
  params,
}: {
  params: Promise<{ slug: string; courseId: string; moduleId: string }>;
}) {
  const { claims, token } = await requireAdmin();
  const { slug, courseId, moduleId } = await params;

  const [orgRes, courseRes, moduleRes] = await Promise.allSettled([
    createRichterClient(OrganizationService, token).getOrganizationBySlug({ slug }),
    createRichterClient(CourseService, token).getCourseById({ id: courseId }),
    createRichterClient(CourseModuleService, token).getCourseModuleById({ id: moduleId }),
  ]);

  if (orgRes.status === "rejected") notFound();
  if (courseRes.status === "rejected") notFound();
  if (moduleRes.status === "rejected") notFound();

  const org = orgRes.value.organization;
  const course = courseRes.value.course;
  const mod = moduleRes.value.module;

  if (!org || !course || !mod) notFound();
  if (course.organizationId !== org.id) notFound();
  if (mod.courseId !== courseId) notFound();

  const lessonClient = createRichterClient(LessonService, token);
  const { lessons } = await lessonClient.listLessons({ moduleId: mod.id, limit: 500, offset: 0 });

  return (
    <div className="flex flex-col gap-6">
      <RecentAccessRecorder
        exactPath
        entry={{
          userId: claims.sub,
          id: `admin-module:${mod.id}`,
          type: "admin-module",
          area: "admin",
          orgSlug: slug,
          title: mod.title,
          subtitle: course.title,
          href: `/admin/organizations/${slug}/courses/${courseId}/modules/${mod.id}`,
        }}
      />

      <Breadcrumbs
        items={[
          { label: "Tổ chức", href: "/admin/organizations" },
          { label: org.name, href: `/admin/organizations/${slug}` },
          { label: "Khóa học", href: `/admin/organizations/${slug}/courses` },
          { label: course.title, href: `/admin/organizations/${slug}/courses/${courseId}` },
          { label: mod.title },
        ]}
      />

      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" asChild className="gap-1">
          <Link href={`/admin/organizations/${slug}/courses/${courseId}`}>
            <ChevronLeftIcon className="size-4" />
            {course.title}
          </Link>
        </Button>
      </div>

      <PageHeader
        title={mod.title}
        description={`Quản lý các bài học trong chương thuộc khóa học ${course.title}.`}
      />

      {/* Danh sách bài học */}
      <div className="rounded-md border p-4 flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <BookOpenIcon className="size-4 text-muted-foreground" />
            <h2 className="font-medium">Bài học ({lessons.length})</h2>
          </div>
          <AddLessonDialog
            moduleId={mod.id}
            courseId={courseId}
            slug={slug}
            nextOrder={lessons.length}
            token={token}
          />
        </div>

        {lessons.length === 0 ? (
          <EmptyState
            icon={<PlaySquareIcon className="size-5" />}
            title="Chưa có bài học nào"
            description="Thêm bài học đầu tiên để bắt đầu xây dựng nội dung cho chương."
          />
        ) : (
          <div className="flex flex-col gap-2">
            {lessons.map((lesson, i) => (
              <div
                key={lesson.id}
                className="flex items-center justify-between rounded-md border px-4 py-3 transition-colors hover:bg-muted/30"
              >
                <div className="flex items-center gap-3">
                  <span className="text-sm text-muted-foreground font-mono w-6">{i + 1}.</span>
                  <div className="flex flex-col">
                    <span className="text-sm font-medium">{lesson.title}</span>
                    {lesson.description && (
                      <span className="text-xs text-muted-foreground">{lesson.description}</span>
                    )}
                  </div>
                </div>
                <LessonActions
                  id={lesson.id}
                  moduleId={mod.id}
                  courseId={courseId}
                  slug={slug}
                  title={lesson.title}
                  description={lesson.description}
                  orderIndex={lesson.orderIndex}
                  token={token}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
