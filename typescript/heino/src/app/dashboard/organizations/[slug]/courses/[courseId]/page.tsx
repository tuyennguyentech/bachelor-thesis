// dashboard course detail
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAnyUser, requireOrgMember } from "@/lib/auth";
import { createRichterClient } from "@/lib/connect-client";
import { OrganizationService } from "buf/gen/richter/v1/organizations_pb";
import { CourseService, CourseModuleService, LessonService } from "buf/gen/richter/v1/courses_pb";
import { OrganizationRole } from "buf/gen/richter/v1/organization_members_pb";
import { Code, ConnectError } from "@connectrpc/connect";
import { Button } from "@/components/ui/button";
import { ChevronLeftIcon, BookOpenIcon } from "lucide-react";
import { courseStatusBadge } from "@/lib/course-utils";
import { EditCourseForm } from "@/app/admin/organizations/[slug]/courses/[courseId]/edit-course-form";
import { CourseStatusSelect } from "@/app/admin/organizations/[slug]/courses/[courseId]/course-status-select";
import { DeleteCourseButton } from "@/app/admin/organizations/[slug]/courses/[courseId]/delete-course-button";
import { AddModuleDialog } from "@/app/admin/organizations/[slug]/courses/[courseId]/add-module-dialog";
import { ModuleActions } from "@/app/admin/organizations/[slug]/courses/[courseId]/module-actions";
import { AddLessonDialog } from "@/app/admin/organizations/[slug]/courses/[courseId]/modules/[moduleId]/add-lesson-dialog";
import { LessonActions } from "@/app/admin/organizations/[slug]/courses/[courseId]/modules/[moduleId]/lesson-actions";

const CAN_MANAGE = [OrganizationRole.OWNER, OrganizationRole.ADMIN, OrganizationRole.TEACHER];
const CAN_CHANGE_STATUS = [OrganizationRole.OWNER, OrganizationRole.ADMIN];

export default async function DashboardCourseDetailPage({
  params,
}: {
  params: Promise<{ slug: string; courseId: string }>;
}) {
  const { slug, courseId } = await params;
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
  const canChangeStatus = CAN_CHANGE_STATUS.includes(member.role);

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
  const lessonClient = createRichterClient(LessonService, token);

  const [{ modules }, { lessons: allLessons }] = await Promise.all([
    moduleClient.listCourseModules({ courseId: course.id, limit: 500, offset: 0 }),
    lessonClient.listLessonsByCourse({ courseId: course.id, limit: 500, offset: 0 }),
  ]);

  const lessonsByModule = new Map<string, typeof allLessons>();
  for (const l of allLessons) {
    const arr = lessonsByModule.get(l.moduleId) ?? [];
    arr.push(l);
    lessonsByModule.set(l.moduleId, arr);
  }
  const modulesWithLessons = modules.map((m) => ({ ...m, lessons: lessonsByModule.get(m.id) ?? [] }));

  const redirectAfterDelete = `/dashboard/organizations/${slug}/courses`;

  return (
    <div className="mx-auto max-w-3xl flex flex-col gap-6">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" asChild className="gap-1">
          <Link href={`/dashboard/organizations/${slug}/courses`}>
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

      {/* Management: edit info + status */}
      {canManage && (
        <>
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
            {canChangeStatus
              ? <CourseStatusSelect courseId={course.id} slug={slug} currentStatus={course.status} token={token} />
              : courseStatusBadge(course.status)
            }
          </div>
        </>
      )}

      {/* Nội dung khóa học */}
      <div className="rounded-lg border p-4 flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <BookOpenIcon className="size-4 text-muted-foreground" />
            <h2 className="font-medium">
              Nội dung ({modulesWithLessons.length} chương)
            </h2>
          </div>
          {canManage && (
            <AddModuleDialog courseId={course.id} slug={slug} nextOrder={modules.length} token={token} />
          )}
        </div>

        {modulesWithLessons.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            {canManage ? "Chưa có chương nào. Thêm chương đầu tiên để bắt đầu." : "Chưa có nội dung."}
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {modulesWithLessons.map((m, mi) => (
              <div key={m.id} className="flex flex-col gap-1">
                <div className="flex items-center justify-between px-2 py-1.5 rounded-md bg-muted/50">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-muted-foreground font-mono w-6">{mi + 1}.</span>
                    <span className="text-sm font-semibold">{m.title}</span>
                    <span className="text-xs text-muted-foreground ml-1">
                      {m.lessons.length} bài
                    </span>
                  </div>
                  {canManage && (
                    <ModuleActions
                      id={m.id}
                      courseId={courseId}
                      slug={slug}
                      title={m.title}
                      orderIndex={m.orderIndex}
                      token={token}
                    />
                  )}
                </div>

                {m.lessons.map((lesson, li) => (
                  <div
                    key={lesson.id}
                    className="flex items-center justify-between px-4 py-2 ml-4 rounded-md border"
                  >
                    <Link
                      href={`/dashboard/organizations/${slug}/courses/${courseId}/lessons/${lesson.id}`}
                      className="flex items-center gap-2 flex-1 min-w-0 hover:opacity-80"
                    >
                      <span className="text-sm text-muted-foreground font-mono w-6">{li + 1}.</span>
                      <div className="flex flex-col min-w-0">
                        <span className="text-sm truncate">{lesson.title}</span>
                        {lesson.description && (
                          <span className="text-xs text-muted-foreground truncate">{lesson.description}</span>
                        )}
                      </div>
                    </Link>
                    {canManage && (
                      <LessonActions
                        id={lesson.id}
                        moduleId={m.id}
                        courseId={courseId}
                        slug={slug}
                        title={lesson.title}
                        description={lesson.description}
                        orderIndex={lesson.orderIndex}
                        token={token}
                      />
                    )}
                  </div>
                ))}

                {canManage && (
                  <div className="ml-4 mt-0.5">
                    <AddLessonDialog
                      moduleId={m.id}
                      courseId={courseId}
                      slug={slug}
                      nextOrder={m.lessons.length}
                      token={token}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Danger zone */}
      {canChangeStatus && (
        <div className="rounded-lg border border-destructive/30 p-4 flex items-center justify-between">
          <div>
            <p className="font-medium text-sm">Xóa khóa học</p>
            <p className="text-xs text-muted-foreground">Hành động này không thể hoàn tác</p>
          </div>
          <DeleteCourseButton
            courseId={course.id}
            slug={slug}
            redirectTo={redirectAfterDelete}
            token={token}
          />
        </div>
      )}
    </div>
  );
}
