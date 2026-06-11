import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAnyUser, requireOrgMember } from "@/lib/auth";
import { createRichterClient } from "@/lib/connect-client";
import { OrganizationService } from "buf/gen/richter/v1/organizations_pb";
import {
  CourseService,
  CourseStatus,
  LessonService,
  type Course,
  type Lesson,
} from "buf/gen/richter/v1/courses_pb";
import { OrganizationRole } from "buf/gen/richter/v1/organization_members_pb";
import { Code, ConnectError } from "@connectrpc/connect";
import {
  ArrowRightIcon,
  BookOpenIcon,
  CalendarIcon,
  GraduationCapIcon,
  PlusIcon,
  LockIcon,
} from "lucide-react";
import { courseStatusBadge } from "@/lib/course-utils";
import { Badge } from "@/components/ui/badge";

const COURSE_LIMIT = 8;
const LESSONS_PER_COURSE = 5;
const RECENT_LESSON_LIMIT = 5;

interface LessonItem {
  lesson: Lesson;
  course: Course;
}

function timestampMs(value?: { seconds: bigint | number | string }) {
  return value ? Number(value.seconds) * 1000 : 0;
}

function lessonHref(slug: string, item: LessonItem) {
  return `/dashboard/organizations/${slug}/courses/${item.course.id}/lessons/${item.lesson.id}`;
}

export default async function OrgDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
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
  const CAN_MANAGE = [OrganizationRole.OWNER, OrganizationRole.ADMIN, OrganizationRole.TEACHER];
  const canManage = CAN_MANAGE.includes(member.role);

  const courseClient = createRichterClient(CourseService, token);
  const lessonClient = createRichterClient(LessonService, token);

  const { courses } = await courseClient
    .listCourses({ organizationId: org.id, limit: COURSE_LIMIT, offset: 0 })
    .catch(() => ({ courses: [] }));

  const lessonResults = await Promise.allSettled(
    courses.map((course) =>
      lessonClient
        .listLessonsByCourse({ courseId: course.id, limit: LESSONS_PER_COURSE, offset: 0 })
        .then((r) => (r.lessons ?? []).map((lesson) => ({ lesson, course }))),
    ),
  );

  const lessonItems: LessonItem[] = lessonResults.flatMap((result) =>
    result.status === "fulfilled" ? result.value : [],
  );

  const recentLessons = [...lessonItems]
    .sort((a, b) => {
      const aTime = timestampMs(a.lesson.updatedAt) || timestampMs(a.lesson.createdAt);
      const bTime = timestampMs(b.lesson.updatedAt) || timestampMs(b.lesson.createdAt);
      return bTime - aTime;
    })
    .slice(0, RECENT_LESSON_LIMIT);

  const publishedCourses = courses.filter((course) => course.status === CourseStatus.PUBLISHED);
  const draftCourses = courses.filter((course) => course.status === CourseStatus.DRAFT);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <h1 className="text-xl font-semibold">Tổng quan tổ chức</h1>
          <p className="text-sm text-muted-foreground">
            Theo dõi nội dung, khóa học và bài học mới cập nhật trong tổ chức này.
          </p>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-4">
        <div className="rounded-md border p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <GraduationCapIcon className="size-4" />
            Khóa học
          </div>
          <p className="mt-2 text-2xl font-semibold">{courses.length}</p>
        </div>
        <div className="rounded-md border p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <BookOpenIcon className="size-4" />
            Bài học
          </div>
          <p className="mt-2 text-2xl font-semibold">{lessonItems.length}</p>
        </div>
        <div className="rounded-md border p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <CalendarIcon className="size-4" />
            Đã xuất bản
          </div>
          <p className="mt-2 text-2xl font-semibold">{publishedCourses.length}</p>
        </div>
        <div className="rounded-md border p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <PlusIcon className="size-4" />
            Bản nháp
          </div>
          <p className="mt-2 text-2xl font-semibold">{draftCourses.length}</p>
        </div>
      </div>

      <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-base font-semibold">Khóa học trong tổ chức</h2>
            <Link
              className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
              href={`/dashboard/organizations/${slug}/courses`}
            >
              Xem danh sách
              <ArrowRightIcon className="size-3.5" />
            </Link>
          </div>

          <div className="rounded-md border">
            {courses.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-muted-foreground">
                Tổ chức này chưa có khóa học nào.
              </p>
            ) : (
              <div className="divide-y">
                {courses.map((course) => {
                  const notEnrolled = !course.canAccess && !canManage;
                  return (
                    <Link
                      key={course.id}
                      href={`/dashboard/organizations/${slug}/courses/${course.id}`}
                      className={`grid gap-3 px-4 py-3 transition-all hover:bg-muted/50 md:grid-cols-[minmax(0,1fr)_auto] ${
                        notEnrolled ? "opacity-75 bg-muted/5" : ""
                      }`}
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          {notEnrolled && <LockIcon className="size-3.5 text-muted-foreground shrink-0" />}
                          <p className="truncate text-sm font-medium">{course.title}</p>
                          {notEnrolled && (
                            <Badge variant="outline" className="text-[10px] bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20 py-0.5">
                              Chưa tham gia
                            </Badge>
                          )}
                        </div>
                        {course.description && (
                          <p className="truncate text-xs text-muted-foreground mt-0.5">{course.description}</p>
                        )}
                      </div>
                      <div className="flex items-center gap-2 md:justify-end">
                        {courseStatusBadge(course.status)}
                        <ArrowRightIcon className="size-3.5 text-muted-foreground" />
                      </div>
                    </Link>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <aside className="flex flex-col gap-3">
          <h2 className="text-base font-semibold">Bài học mới cập nhật</h2>
          <div className="rounded-md border">
            {recentLessons.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-muted-foreground">
                Chưa có bài học để mở nhanh.
              </p>
            ) : (
              <div className="divide-y">
                {recentLessons.map((item) => (
                  <Link
                    key={`${item.course.id}:${item.lesson.id}`}
                    href={lessonHref(slug, item)}
                    className="block px-4 py-3 transition-colors hover:bg-muted/50"
                  >
                    <p className="truncate text-sm font-medium">{item.lesson.title}</p>
                    <p className="truncate text-xs text-muted-foreground">{item.course.title}</p>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </aside>
      </section>
    </div>
  );
}
