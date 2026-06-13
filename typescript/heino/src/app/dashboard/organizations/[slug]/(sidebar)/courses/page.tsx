import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAnyUser, requireOrgMember } from "@/lib/auth";
import { createRichterClient } from "@/lib/connect-client";
import { OrganizationService } from "buf/gen/richter/v1/organizations_pb";
import { CourseService, Course, CourseStatus, CourseModuleService, LessonService } from "buf/gen/richter/v1/courses_pb";
import { InteractionService, MyCourseProgress } from "buf/gen/richter/v1/interactions_pb";
import { OrganizationRole } from "buf/gen/richter/v1/organization_members_pb";
import { Code, ConnectError } from "@connectrpc/connect";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import { GraduationCapIcon, LockIcon, ArrowRightIcon, BookOpenIcon, SearchIcon, AlertTriangleIcon } from "lucide-react";
import { courseStatusBadge } from "@/lib/course-utils";
import { Pagination } from "@/components/pagination";
import { CreateCourseDialog } from "@/app/admin/organizations/[slug]/courses/create-course-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { RecentAccessRecorder } from "@/components/dashboard/recent-access-recorder";
import { Input } from "@/components/ui/input";

const LIMIT = 20;
const CAN_MANAGE = [OrganizationRole.OWNER, OrganizationRole.ADMIN, OrganizationRole.TEACHER];

export default async function DashboardCoursesPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ page?: string; q?: string }>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);
  const offset = (page - 1) * LIMIT;
  const q = sp.q?.trim() || undefined;

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
  // canManage = org-level capability that includes TEACHER: may create courses
  // and see drafts. Whether a teacher can MANAGE a given course, though, is
  // per-course (owner or course-manager member), so course access/locking below
  // uses canManageOrgAdmin (OWNER/ADMIN only) + per-course ownership — mirroring
  // the backend, where an org TEACHER is not a blanket course-management bypass.
  const canManage = CAN_MANAGE.includes(member.role);
  const canManageOrgAdmin = [OrganizationRole.OWNER, OrganizationRole.ADMIN].includes(member.role);
  // A course is manageable from a card when the viewer bypasses at the org level
  // or owns that course. (Course-manager TEACHER members still manage it from the
  // course page; on the list they appear as accessible.)
  const cardCanManage = (c: Course) => canManageOrgAdmin || c.ownerId === claims.sub;

  const courseClient = createRichterClient(CourseService, token);
  let courses: Course[] = [];
  let coursesError = false;
  try {
    const res = await courseClient.listCourses({
      organizationId: org.id,
      limit: LIMIT,
      offset,
      // Non-managers must never see/paginate drafts; exclude them server-side
      // so LIMIT counts only visible courses (otherwise a page of drafts renders empty).
      excludeDrafts: !canManage,
      ...(q ? { q } : {}),
    });
    courses = res.courses ?? [];
  } catch {
    coursesError = true;
    courses = [];
  }
  const hasNext = courses.length === LIMIT;

  // ── Student progress: completed-lesson count per course (non-managers only) ──
  const progressMap = new Map<string, MyCourseProgress>();
  if (!canManageOrgAdmin) {
    try {
      const interactionClient = createRichterClient(InteractionService, token);
      const { courses: progress } = await interactionClient.listMyCourseProgress({
        limit: 200,
        offset: 0,
      });
      for (const p of progress) progressMap.set(p.courseId, p);
    } catch {
      // Progress is non-critical; fall back to no progress bars.
    }
  }

  // Fetch modules and lessons count for each course
  const courseDetails = await Promise.all(
    courses.map(async (c) => {
      const moduleClient = createRichterClient(CourseModuleService, token);
      const lessonClient = createRichterClient(LessonService, token);
      try {
        const [{ modules }, { lessons }] = await Promise.all([
          moduleClient.listCourseModules({ courseId: c.id, limit: 100, offset: 0 }),
          lessonClient.listLessonsByCourse({ courseId: c.id, limit: 100, offset: 0 })
        ]);
        return {
          courseId: c.id,
          modulesCount: modules.length as number | undefined,
          lessonsCount: lessons.length as number | undefined
        };
      } catch {
        return { courseId: c.id, modulesCount: undefined, lessonsCount: undefined };
      }
    })
  );
  const detailsMap = new Map(courseDetails.map((d) => [d.courseId, d]));

  // Plain members must not see authoring drafts; managers see everything.
  const visibleCourses = canManage
    ? courses
    : courses.filter((c) => c.status !== CourseStatus.DRAFT);
  // Accessibility/locking is per-course: org OWNER/ADMIN bypass everything, but
  // an org TEACHER only accesses courses they may actually open (canAccess), so
  // courses they neither own nor belong to surface as "locked" → request-to-manage.
  const accessibleCourses = visibleCourses.filter((c) => c.canAccess || canManageOrgAdmin);
  const lockedCourses = visibleCourses.filter((c) => !c.canAccess && !canManageOrgAdmin);

  return (
    <div className="flex flex-col gap-4">
      <RecentAccessRecorder
        exactPath
        entry={{
          userId: claims.sub,
          id: `organization-courses:${org.id}`,
          type: "organization-courses",
          orgSlug: slug,
          title: "Khóa học",
          subtitle: org.name,
          href: `/dashboard/organizations/${slug}/courses`,
        }}
      />

      <PageHeader
        title="Khóa học"
        description={`Danh sách khóa học trong tổ chức ${org.name}.`}
        actions={canManage && <CreateCourseDialog organizationId={org.id} slug={slug} token={token} userId={claims.sub} />}
      />

      {/* ── SEARCH BAR ── */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between bg-card p-4 rounded-lg border">
        <form method="GET" className="flex items-center gap-2 w-full sm:max-w-sm">
          <div className="relative w-full">
            <SearchIcon className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              type="search"
              name="q"
              placeholder="Tìm kiếm khóa học..."
              defaultValue={q || ""}
              className="pl-9 h-9"
            />
          </div>
          <Button type="submit" size="sm" variant="secondary">Tìm</Button>
          {q && (
            <Button variant="ghost" size="sm" asChild>
              <Link href={`/dashboard/organizations/${slug}/courses`}>Xóa</Link>
            </Button>
          )}
        </form>
        {q && (
          <div className="text-xs text-muted-foreground">
            Kết quả tìm kiếm cho: &ldquo;<span className="font-medium text-foreground">{q}</span>&rdquo;
          </div>
        )}
      </div>

      <div className="flex flex-col gap-8">
        {coursesError ? (
          <div className="rounded-md border bg-card">
            <EmptyState
              icon={<AlertTriangleIcon className="size-5 text-destructive" />}
              title="Không thể tải danh sách khóa học"
              description="Đã xảy ra lỗi khi tải khóa học. Vui lòng thử lại sau."
            />
          </div>
        ) : courses.length === 0 ? (
          <div className="rounded-md border bg-card">
            <EmptyState
              icon={<GraduationCapIcon className="size-5" />}
              title="Chưa có khóa học nào"
              description={
                canManage
                  ? "Tạo khóa học đầu tiên để bắt đầu xây dựng nội dung cho tổ chức."
                  : "Tổ chức này chưa mở khóa học cho thành viên."
              }
            />
          </div>
        ) : (
          <>
            {/* ── SECTION 1: ACCESSIBLE/JOINED COURSES ── */}
            {accessibleCourses.length > 0 && (
              <div className="flex flex-col gap-4">
                <div className="flex items-center gap-2">
                  <div className="h-5 w-1 rounded-full bg-blue-600" />
                  <h2 className="text-lg font-semibold tracking-tight">Khóa học của bạn</h2>
                  <Badge variant="secondary" className="bg-blue-500/10 text-blue-600 border-none font-medium">
                    {accessibleCourses.length}
                  </Badge>
                </div>
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {accessibleCourses.map((course) => {
                    const details = detailsMap.get(course.id);
                    const progress = progressMap.get(course.id);
                    const lessonsDone = progress?.lessonsDone ?? 0;
                    const lessonsTotal = progress?.lessonsTotal ?? 0;
                    const progressPct = lessonsTotal > 0 ? Math.round((lessonsDone / lessonsTotal) * 100) : 0;
                    return (
                    <Card key={course.id} className="group relative flex flex-col justify-between border bg-card transition-all duration-300 hover:-translate-y-1 hover:shadow-lg hover:border-primary/50">
                      <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-blue-500 via-indigo-500 to-violet-500" />

                      <CardHeader className="pt-6">
                        <div className="flex items-start justify-between gap-2">
                          <div className="rounded-md bg-blue-500/10 p-2 text-blue-600 dark:text-blue-400">
                            <BookOpenIcon className="size-5" />
                          </div>
                          {cardCanManage(course) && courseStatusBadge(course.status)}
                        </div>
                        <CardTitle className="mt-4 text-base font-semibold group-hover:text-primary transition-colors line-clamp-1">
                          {course.title}
                        </CardTitle>
                        <CardDescription className="line-clamp-2 min-h-8 mt-1 text-xs">
                          {course.description || "Chưa có mô tả cho khóa học này."}
                        </CardDescription>
                      </CardHeader>

                      <CardContent className="py-2 text-xs text-muted-foreground flex flex-col gap-1.5">
                        <div className="flex items-center justify-between">
                          <span>Chương học:</span>
                          <span className="font-medium text-foreground">
                            {details?.modulesCount === undefined ? "—" : `${details.modulesCount} chương`}
                          </span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span>Bài học:</span>
                          <span className="font-medium text-foreground">
                            {details?.lessonsCount === undefined ? "—" : `${details.lessonsCount} bài`}
                          </span>
                        </div>
                        {!cardCanManage(course) && (
                          <div className="flex flex-col gap-1 pt-0.5">
                            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                              <div
                                className="h-full rounded-full bg-blue-600 transition-all"
                                style={{ width: `${progressPct}%` }}
                              />
                            </div>
                            <span className="text-muted-foreground/80">
                              {lessonsDone}/{lessonsTotal} bài hoàn thành
                            </span>
                          </div>
                        )}
                      </CardContent>

                      <CardFooter className="pt-4 border-t bg-muted/20 flex items-center justify-between gap-2">
                        {cardCanManage(course) ? (
                          // Manager (course owner / org owner-admin) accesses via
                          // bypass — they are NOT a learner-member, so label them
                          // "Quản lý", not "Đang tham gia".
                          <Badge variant="outline" className="text-[10px] bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/20 font-medium shrink-0">
                            Quản lý
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-[10px] bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/20 font-medium shrink-0">
                            Đang tham gia
                          </Badge>
                        )}
                        {cardCanManage(course) ? (
                          // Manager: split CTA — learn (real) or manage.
                          <div className="flex items-center gap-1.5" data-testid="course-card-manager-cta">
                            <Button size="sm" variant="outline" className="gap-1 transition-all" asChild>
                              <Link href={`/dashboard/organizations/${slug}/courses/${course.id}?mode=learn`} data-testid="card-learn">
                                <GraduationCapIcon className="size-3.5" />
                                Vào học
                              </Link>
                            </Button>
                            <Button size="sm" className="gap-1 transition-all group-hover:translate-x-0.5" asChild>
                              <Link href={`/dashboard/organizations/${slug}/courses/${course.id}`} data-testid="card-manage">
                                Quản lý
                                <ArrowRightIcon className="size-3.5" />
                              </Link>
                            </Button>
                          </div>
                        ) : (
                          <Button size="sm" className="gap-1.5 transition-all group-hover:translate-x-0.5" asChild>
                            <Link href={`/dashboard/organizations/${slug}/courses/${course.id}`} data-testid="card-learn">
                              {lessonsDone > 0 ? "Tiếp tục học" : "Vào học"}
                              <ArrowRightIcon className="size-3.5" />
                            </Link>
                          </Button>
                        )}
                      </CardFooter>
                    </Card>
                    );
                  })}
                </div>
              </div>
            )}

            {/* ── SECTION 2: LOCKED COURSES ── */}
            {lockedCourses.length > 0 && (
              <div className="flex flex-col gap-4 mt-2">
                <div className="flex items-center gap-2">
                  <div className="h-5 w-1 rounded-full bg-muted-foreground/45" />
                  <h2 className="text-lg font-semibold tracking-tight text-muted-foreground">Khóa học khác trong tổ chức</h2>
                  <Badge variant="secondary" className="bg-muted text-muted-foreground border-none font-medium">
                    {lockedCourses.length}
                  </Badge>
                </div>
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {lockedCourses.map((course) => (
                    <Card key={course.id} className="group relative flex flex-col justify-between border border-dashed bg-muted/5 opacity-85 hover:opacity-100 transition-all duration-300 hover:border-muted-foreground/30">
                      <div className="absolute top-0 left-0 right-0 h-1 bg-muted-foreground/20" />
                      
                      <CardHeader className="pt-6">
                        <div className="flex items-start justify-between gap-2">
                          <div className="rounded-md bg-muted p-2 text-muted-foreground">
                            <LockIcon className="size-5" />
                          </div>
                          <Badge variant="secondary" className="text-[10px] bg-muted text-muted-foreground border-none">
                            Yêu cầu tham gia
                          </Badge>
                        </div>
                        <CardTitle className="mt-4 text-base font-semibold text-muted-foreground line-clamp-1">
                          {course.title}
                        </CardTitle>
                        <CardDescription className="line-clamp-2 min-h-8 mt-1 text-xs text-muted-foreground/75">
                          {course.description || "Chưa có mô tả cho khóa học này."}
                        </CardDescription>
                      </CardHeader>

                      <CardContent className="py-2 text-xs text-muted-foreground/60 flex flex-col gap-1.5">
                        <div className="flex items-center justify-between">
                          <span>Chương học:</span>
                          <span className="font-medium text-foreground/80">
                            {detailsMap.get(course.id)?.modulesCount === undefined ? "—" : `${detailsMap.get(course.id)!.modulesCount} chương`}
                          </span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span>Bài học:</span>
                          <span className="font-medium text-foreground/80">
                            {detailsMap.get(course.id)?.lessonsCount === undefined ? "—" : `${detailsMap.get(course.id)!.lessonsCount} bài`}
                          </span>
                        </div>
                      </CardContent>
                      
                      <CardFooter className="pt-4 border-t bg-muted/10 flex items-center justify-between">
                        <Badge variant="secondary" className="text-[10px] bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20 flex items-center gap-1 font-medium">
                          <LockIcon className="size-2.5" />
                          Chưa tham gia
                        </Badge>
                        <Button size="sm" variant="outline" className="gap-1.5 border-dashed" asChild>
                          <Link href={`/dashboard/organizations/${slug}/courses/${course.id}`} data-testid="card-request-join">
                            Yêu cầu tham gia
                            <ArrowRightIcon className="size-3.5" />
                          </Link>
                        </Button>
                      </CardFooter>
                    </Card>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <Pagination
        page={page}
        hasNext={hasNext}
        buildHref={(p) => `/dashboard/organizations/${slug}/courses?page=${p}${q ? `&q=${encodeURIComponent(q)}` : ""}`}
      />
    </div>
  );
}
