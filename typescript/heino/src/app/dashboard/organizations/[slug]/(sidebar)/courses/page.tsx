import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAnyUser, requireOrgMember } from "@/lib/auth";
import { createRichterClient } from "@/lib/connect-client";
import { OrganizationService } from "buf/gen/richter/v1/organizations_pb";
import { CourseService, Course } from "buf/gen/richter/v1/courses_pb";
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
import { GraduationCapIcon, LockIcon, ArrowRightIcon, BookOpenIcon } from "lucide-react";
import { courseStatusBadge } from "@/lib/course-utils";
import { Pagination } from "@/components/pagination";
import { CreateCourseDialog } from "@/app/admin/organizations/[slug]/courses/create-course-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { RecentAccessRecorder } from "@/components/dashboard/recent-access-recorder";

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
  const canManage = CAN_MANAGE.includes(member.role);

  const courseClient = createRichterClient(CourseService, token);
  let courses: Course[] = [];
  try {
    const res = await courseClient.listCourses({
      organizationId: org.id,
      limit: LIMIT,
      offset,
      ...(q ? { q } : {}),
    });
    courses = res.courses ?? [];
  } catch {
    courses = [];
  }
  const hasNext = courses.length === LIMIT;

  const accessibleCourses = courses.filter((c) => c.canAccess || canManage);
  const lockedCourses = courses.filter((c) => !c.canAccess && !canManage);

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

      <div className="flex flex-col gap-8">
        {courses.length === 0 ? (
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
                  {accessibleCourses.map((course) => (
                    <Card key={course.id} className="group relative flex flex-col justify-between border bg-card transition-all duration-300 hover:-translate-y-1 hover:shadow-lg hover:border-primary/50">
                      <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-blue-500 via-indigo-500 to-violet-500" />
                      
                      <CardHeader className="pt-6">
                        <div className="flex items-start justify-between gap-2">
                          <div className="rounded-md bg-blue-500/10 p-2 text-blue-600 dark:text-blue-400">
                            <BookOpenIcon className="size-5" />
                          </div>
                          {courseStatusBadge(course.status)}
                        </div>
                        <CardTitle className="mt-4 text-base font-semibold group-hover:text-primary transition-colors line-clamp-1">
                          {course.title}
                        </CardTitle>
                        <CardDescription className="line-clamp-2 min-h-[2.5rem] mt-1 text-xs">
                          {course.description || "Chưa có mô tả cho khóa học này."}
                        </CardDescription>
                      </CardHeader>
                      
                      <CardContent className="py-2 text-xs text-muted-foreground flex items-center justify-between">
                        <span>Ngày tạo:</span>
                        <span>
                          {course.createdAt
                            ? new Date(Number(course.createdAt.seconds) * 1000).toLocaleDateString("vi-VN")
                            : "—"}
                        </span>
                      </CardContent>
                      
                      <CardFooter className="pt-4 border-t bg-muted/20 flex items-center justify-between">
                        <Badge variant="outline" className="text-[10px] bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/20 font-medium">
                          Đang tham gia
                        </Badge>
                        <Button size="sm" className="gap-1.5 transition-all group-hover:translate-x-0.5" asChild>
                          <Link href={`/dashboard/organizations/${slug}/courses/${course.id}`}>
                            {canManage ? "Quản lý" : "Vào học"}
                            <ArrowRightIcon className="size-3.5" />
                          </Link>
                        </Button>
                      </CardFooter>
                    </Card>
                  ))}
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
                        <CardDescription className="line-clamp-2 min-h-[2.5rem] mt-1 text-xs text-muted-foreground/75">
                          {course.description || "Chưa có mô tả cho khóa học này."}
                        </CardDescription>
                      </CardHeader>
                      
                      <CardContent className="py-2 text-xs text-muted-foreground/60 flex items-center justify-between">
                        <span>Ngày tạo:</span>
                        <span>
                          {course.createdAt
                            ? new Date(Number(course.createdAt.seconds) * 1000).toLocaleDateString("vi-VN")
                            : "—"}
                        </span>
                      </CardContent>
                      
                      <CardFooter className="pt-4 border-t bg-muted/10 flex items-center justify-between">
                        <Badge variant="secondary" className="text-[10px] bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20 flex items-center gap-1 font-medium">
                          <LockIcon className="size-2.5" />
                          Chưa tham gia
                        </Badge>
                        <Button size="sm" variant="outline" className="gap-1.5 border-dashed" asChild>
                          <Link href={`/dashboard/organizations/${slug}/courses/${course.id}`}>
                            Yêu cầu
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
