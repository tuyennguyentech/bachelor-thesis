import { requireAdmin } from "@/lib/auth";
import { createRichterClient } from "@/lib/connect-client";
import { OrganizationService } from "buf/gen/richter/v1/organizations_pb";
import { CourseService, CourseModuleService } from "buf/gen/richter/v1/courses_pb";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { ChevronLeftIcon, BookOpenIcon } from "lucide-react";
import { notFound } from "next/navigation";
import { courseStatusBadge } from "@/lib/course-utils";
import { EditCourseForm } from "./edit-course-form";
import { CourseStatusSelect } from "./course-status-select";
import { DeleteCourseButton } from "./delete-course-button";
import { AddModuleDialog } from "./add-module-dialog";
import { ModuleActions } from "./module-actions";

export default async function CourseDetailPage({
  params,
}: {
  params: Promise<{ slug: string; courseId: string }>;
}) {
  const { token } = await requireAdmin();
  const { slug, courseId } = await params;

  const orgClient = createRichterClient(OrganizationService, token);
  let org;
  try {
    const res = await orgClient.getOrganizationBySlug({ slug });
    org = res.organization;
  } catch {
    notFound();
  }
  if (!org) notFound();

  const courseClient = createRichterClient(CourseService, token);
  let course;
  try {
    const res = await courseClient.getCourseById({ id: courseId });
    course = res.course;
  } catch {
    notFound();
  }
  if (!course) notFound();
  if (course.organizationId !== org.id) notFound();

  const moduleClient = createRichterClient(CourseModuleService, token);
  const { modules } = await moduleClient.listCourseModules({ courseId: course.id, limit: 500, offset: 0 });

  return (
    <div className="mx-auto max-w-3xl flex flex-col gap-6">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Link href="/admin/organizations" className="hover:text-foreground">Organizations</Link>
        <span>/</span>
        <Link href={`/admin/organizations/${slug}`} className="hover:text-foreground">{org.name}</Link>
        <span>/</span>
        <Link href={`/admin/organizations/${slug}/courses`} className="hover:text-foreground">Khóa học</Link>
        <span>/</span>
        <span className="text-foreground truncate max-w-[200px]">{course.title}</span>
      </div>

      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" asChild className="gap-1">
          <Link href={`/admin/organizations/${slug}/courses`}>
            <ChevronLeftIcon className="size-4" />
            Khóa học
          </Link>
        </Button>
      </div>

      <div className="flex items-start justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold">{course.title}</h1>
          {course.description && (
            <p className="text-sm text-muted-foreground">{course.description}</p>
          )}
        </div>
        {courseStatusBadge(course.status)}
      </div>

      {/* Thông tin chung */}
      <div className="rounded-lg border p-4 flex flex-col gap-4">
        <h2 className="font-medium">Thông tin chung</h2>
        <EditCourseForm
          key={`${course.title}|${course.description}`}
          courseId={course.id}
          slug={slug}
          title={course.title}
          description={course.description}
          token={token}
        />
      </div>

      {/* Trạng thái */}
      <div className="rounded-lg border p-4 flex items-center justify-between gap-4">
        <div>
          <h2 className="font-medium">Trạng thái</h2>
          <p className="text-sm text-muted-foreground">
            Ngày tạo:{" "}
            {course.createdAt
              ? new Date(Number(course.createdAt.seconds) * 1000).toLocaleDateString("vi-VN")
              : "—"}
          </p>
        </div>
        <CourseStatusSelect courseId={course.id} slug={slug} currentStatus={course.status} token={token} />
      </div>

      {/* Chương học */}
      <div className="rounded-lg border p-4 flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <BookOpenIcon className="size-4 text-muted-foreground" />
            <h2 className="font-medium">Nội dung chương ({modules.length})</h2>
          </div>
          <AddModuleDialog courseId={course.id} slug={slug} nextOrder={modules.length} token={token} />
        </div>

        {modules.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            Chưa có chương nào. Thêm chương đầu tiên để bắt đầu.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {modules.map((m, i) => (
              <div
                key={m.id}
                className="flex items-center justify-between rounded-md border px-4 py-3"
              >
                <div className="flex items-center gap-3">
                  <span className="text-sm text-muted-foreground font-mono w-6">{i + 1}.</span>
                  <Link
                    href={`/admin/organizations/${slug}/courses/${courseId}/modules/${m.id}`}
                    className="text-sm font-medium hover:underline"
                  >
                    {m.title}
                  </Link>
                </div>
                <ModuleActions
                  id={m.id}
                  courseId={courseId}
                  slug={slug}
                  title={m.title}
                  orderIndex={m.orderIndex}
                  token={token}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Danger zone */}
      <div className="rounded-lg border border-destructive/30 p-4 flex items-center justify-between">
        <div>
          <p className="font-medium text-sm">Xóa khóa học</p>
          <p className="text-xs text-muted-foreground">Hành động này không thể hoàn tác</p>
        </div>
        <DeleteCourseButton courseId={course.id} slug={slug} token={token} />
      </div>
    </div>
  );
}
