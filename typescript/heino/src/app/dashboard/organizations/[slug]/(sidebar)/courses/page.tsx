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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ChevronRightIcon, GraduationCapIcon, LockIcon } from "lucide-react";
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

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Tên khóa học</TableHead>
              <TableHead>Trạng thái</TableHead>
              <TableHead>Ngày tạo</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {courses.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="p-0">
                  <EmptyState
                    icon={<GraduationCapIcon className="size-5" />}
                    title="Chưa có khóa học nào"
                    description={
                      canManage
                        ? "Tạo khóa học đầu tiên để bắt đầu xây dựng nội dung cho tổ chức."
                        : "Tổ chức này chưa mở khóa học cho thành viên."
                    }
                  />
                </TableCell>
              </TableRow>
            ) : (
              courses.map((course) => {
                const notEnrolled = !course.canAccess && !canManage;
                return (
                  <TableRow key={course.id} className={notEnrolled ? "opacity-90 hover:opacity-100" : undefined}>
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2">
                        {notEnrolled && <LockIcon className="size-3.5 text-muted-foreground shrink-0" />}
                        <span>{course.title}</span>
                        {notEnrolled && (
                          <Badge variant="secondary" className="text-xs">Chưa tham gia</Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>{courseStatusBadge(course.status)}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {course.createdAt
                        ? new Date(Number(course.createdAt.seconds) * 1000).toLocaleDateString("vi-VN")
                        : "—"}
                    </TableCell>
                    <TableCell>
                      <Button variant="ghost" size="sm" asChild>
                        <Link href={`/dashboard/organizations/${slug}/courses/${course.id}`}>
                          <ChevronRightIcon className="size-4" />
                        </Link>
                      </Button>
                    </TableCell>
                  </TableRow>

                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      <Pagination
        page={page}
        hasNext={hasNext}
        buildHref={(p) => `/dashboard/organizations/${slug}/courses?page=${p}${q ? `&q=${encodeURIComponent(q)}` : ""}`}
      />
    </div>
  );
}
