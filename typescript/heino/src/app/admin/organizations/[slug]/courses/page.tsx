import { requireAdmin } from "@/lib/auth";
import { createRichterClient } from "@/lib/connect-client";
import { OrganizationService } from "buf/gen/richter/v1/organizations_pb";
import { CourseService, Course } from "buf/gen/richter/v1/courses_pb";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { ChevronLeftIcon } from "lucide-react";
import { notFound } from "next/navigation";
import { Pagination } from "@/components/pagination";
import { courseStatusBadge } from "@/lib/course-utils";
import { CreateCourseDialog } from "./create-course-dialog";

const LIMIT = 20;

export default async function CoursesPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const { claims, token } = await requireAdmin();
  const { slug } = await params;
  const sp = await searchParams;
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);
  const offset = (page - 1) * LIMIT;

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
  let courses: Course[] = [];
  try {
    const res = await courseClient.listCourses({
      organizationId: org.id,
      limit: LIMIT,
      offset,
    });
    courses = res.courses ?? [];
  } catch {
    courses = [];
  }
  const hasNext = courses.length === LIMIT;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Link href="/admin/organizations" className="hover:text-foreground">Organizations</Link>
        <span>/</span>
        <Link href={`/admin/organizations/${slug}`} className="hover:text-foreground">{org.name}</Link>
        <span>/</span>
        <span className="text-foreground">Khóa học</span>
      </div>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" asChild className="gap-1">
            <Link href={`/admin/organizations/${slug}`}>
              <ChevronLeftIcon className="size-4" />
              {org.name}
            </Link>
          </Button>
          <h1 className="text-xl font-semibold">Khóa học</h1>
        </div>
        <CreateCourseDialog organizationId={org.id} slug={slug} token={token} userId={claims.sub} />
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Tên</TableHead>
              <TableHead>Mô tả</TableHead>
              <TableHead>Trạng thái</TableHead>
              <TableHead>Ngày tạo</TableHead>
              <TableHead className="w-20" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {courses.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                  Chưa có khóa học nào
                </TableCell>
              </TableRow>
            ) : (
              courses.map((course) => (
                <TableRow key={course.id}>
                  <TableCell className="font-medium">{course.title}</TableCell>
                  <TableCell className="text-muted-foreground text-sm max-w-xs truncate">
                    {course.description || "—"}
                  </TableCell>
                  <TableCell>{courseStatusBadge(course.status)}</TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {course.createdAt
                      ? new Date(Number(course.createdAt.seconds) * 1000).toLocaleDateString("vi-VN")
                      : "—"}
                  </TableCell>
                  <TableCell>
                    <Button variant="ghost" size="sm" asChild>
                      <Link href={`/admin/organizations/${slug}/courses/${course.id}`}>
                        Chi tiết
                      </Link>
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <Pagination
        page={page}
        hasNext={hasNext}
        buildHref={(p) => `/admin/organizations/${slug}/courses?page=${p}`}
      />
    </div>
  );
}
