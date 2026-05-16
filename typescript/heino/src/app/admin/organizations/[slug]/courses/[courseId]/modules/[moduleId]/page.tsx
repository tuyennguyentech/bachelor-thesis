import { requireAdmin } from "@/lib/auth";
import { createRichterClient } from "@/lib/connect-client";
import { OrganizationService } from "buf/gen/richter/v1/organizations_pb";
import { CourseService, CourseModuleService, LessonService } from "buf/gen/richter/v1/courses_pb";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { ChevronLeftIcon, BookOpenIcon } from "lucide-react";
import { notFound } from "next/navigation";
import { AddLessonDialog } from "./add-lesson-dialog";
import { LessonActions } from "./lesson-actions";

export default async function ModuleDetailPage({
  params,
}: {
  params: Promise<{ slug: string; courseId: string; moduleId: string }>;
}) {
  const { token } = await requireAdmin();
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
    <div className="mx-auto max-w-3xl flex flex-col gap-6">
      <div className="flex items-center gap-2 text-sm text-muted-foreground flex-wrap">
        <Link href="/admin/organizations" className="hover:text-foreground">Organizations</Link>
        <span>/</span>
        <Link href={`/admin/organizations/${slug}`} className="hover:text-foreground">{org.name}</Link>
        <span>/</span>
        <Link href={`/admin/organizations/${slug}/courses`} className="hover:text-foreground">Khóa học</Link>
        <span>/</span>
        <Link href={`/admin/organizations/${slug}/courses/${courseId}`} className="hover:text-foreground truncate max-w-[140px]">
          {course.title}
        </Link>
        <span>/</span>
        <span className="text-foreground truncate max-w-[140px]">{mod.title}</span>
      </div>

      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" asChild className="gap-1">
          <Link href={`/admin/organizations/${slug}/courses/${courseId}`}>
            <ChevronLeftIcon className="size-4" />
            {course.title}
          </Link>
        </Button>
      </div>

      <h1 className="text-xl font-semibold">{mod.title}</h1>

      {/* Danh sách bài học */}
      <div className="rounded-lg border p-4 flex flex-col gap-4">
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
          <p className="text-sm text-muted-foreground py-4 text-center">
            Chưa có bài học nào. Thêm bài học đầu tiên để bắt đầu.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {lessons.map((lesson, i) => (
              <div
                key={lesson.id}
                className="flex items-center justify-between rounded-md border px-4 py-3"
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
