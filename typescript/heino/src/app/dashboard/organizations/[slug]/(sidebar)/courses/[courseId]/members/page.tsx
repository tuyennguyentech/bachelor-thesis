import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAnyUser, requireOrgMember } from "@/lib/auth";
import { createRichterClient } from "@/lib/connect-client";
import { OrganizationService } from "buf/gen/richter/v1/organizations_pb";
import { CourseService } from "buf/gen/richter/v1/courses_pb";
import { CourseMemberService, CourseRole, type CourseMember } from "buf/gen/richter/v1/course_members_pb";
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
import { ChevronLeftIcon, UsersIcon } from "lucide-react";
import { Pagination } from "@/components/pagination";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { AddCourseMemberDialog } from "./add-course-member-dialog";
import { CourseMemberActionsMenu } from "./course-member-actions-menu";

const LIMIT = 50;
const ORG_CAN_MANAGE = [OrganizationRole.OWNER, OrganizationRole.ADMIN, OrganizationRole.TEACHER];

function courseRoleBadge(role: CourseRole) {
  if (role === CourseRole.TEACHER)
    return <Badge variant="outline" className="border-blue-500 text-blue-600">Giảng viên</Badge>;
  if (role === CourseRole.STUDENT)
    return <Badge variant="outline">Học viên</Badge>;
  return <Badge variant="secondary">Không xác định</Badge>;
}

export default async function CourseMembersPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; courseId: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const { slug, courseId } = await params;
  const sp = await searchParams;
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);
  const offset = (page - 1) * LIMIT;

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

  const { member: currentOrgMember } = await requireOrgMember(org.id);
  const canManage = ORG_CAN_MANAGE.includes(currentOrgMember.role);

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

  // Course owner (regardless of org role) can also manage members
  const isCoursOwner = course.ownerId === claims.sub;
  const effectiveCanManage = canManage || isCoursOwner;

  const memberClient = createRichterClient(CourseMemberService, token);
  let members: CourseMember[] = [];
  try {
    const res = await memberClient.listCourseMembers({
      courseId: course.id,
      limit: LIMIT,
      offset,
    });
    members = res.members ?? [];
  } catch {
    members = [];
  }
  const hasNext = members.length === LIMIT;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" asChild className="gap-1">
          <Link href={`/dashboard/organizations/${slug}/courses/${courseId}`}>
            <ChevronLeftIcon className="size-4" />
            {course.title}
          </Link>
        </Button>
      </div>

      <PageHeader
        title="Thành viên khóa học"
        description={`Danh sách người dùng đang tham gia khóa học "${course.title}".`}
        actions={effectiveCanManage && (
          <AddCourseMemberDialog courseId={course.id} token={token} />
        )}
      />

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Thành viên</TableHead>
              <TableHead>Vai trò</TableHead>
              <TableHead>Ngày tham gia</TableHead>
              {effectiveCanManage && <TableHead className="w-12" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.length === 0 ? (
              <TableRow>
                <TableCell colSpan={effectiveCanManage ? 4 : 3} className="p-0">
                  <EmptyState
                    icon={<UsersIcon className="size-5" />}
                    title="Chưa có thành viên"
                    description={
                      effectiveCanManage
                        ? "Thêm thành viên để phân quyền học hoặc dạy trong khóa học này."
                        : "Khóa học này chưa có thành viên khác."
                    }
                  />
                </TableCell>
              </TableRow>
            ) : (
              members.map((m) => {
                const displayName =
                  `${m.userFirstName} ${m.userLastName}`.trim() || m.userId;
                return (
                  <TableRow key={m.userId}>
                    <TableCell>
                      <div className="flex flex-col gap-0.5">
                        <span className="text-sm font-medium">{displayName}</span>
                        {m.userEmail && (
                          <span className="text-xs text-muted-foreground">{m.userEmail}</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>{courseRoleBadge(m.role)}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {m.createdAt
                        ? new Date(Number(m.createdAt.seconds) * 1000).toLocaleDateString("vi-VN")
                        : "—"}
                    </TableCell>
                    {effectiveCanManage && (
                      <TableCell>
                        <CourseMemberActionsMenu
                          courseId={m.courseId}
                          userId={m.userId}
                          displayName={displayName}
                          token={token}
                        />
                      </TableCell>
                    )}
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
        buildHref={(p) =>
          `/dashboard/organizations/${slug}/courses/${courseId}/members?page=${p}`
        }
      />
    </div>
  );
}
