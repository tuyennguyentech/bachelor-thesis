import Link from "next/link";
import { cookies } from "next/headers";
import { requireAnyUser, displayName } from "@/lib/auth";
import { createRichterClient } from "@/lib/connect-client";
import {
  MemberStatus,
  OrganizationMemberService,
  OrganizationRole,
  type OrganizationMember,
} from "buf/gen/richter/v1/organization_members_pb";
import { OrganizationService, type Organization } from "buf/gen/richter/v1/organizations_pb";
import { CourseService, CourseStatus } from "buf/gen/richter/v1/courses_pb";
import { UserRole } from "buf/gen/richter/v1/users_pb";
import { InteractionService, type MyCourseProgress } from "buf/gen/richter/v1/interactions_pb";
import { Button } from "@/components/ui/button";
import {
  ArrowRightIcon,
  BookOpenIcon,
  BuildingIcon,
  Clock3Icon,
  GraduationCapIcon,
  ShieldCheckIcon,
  UserIcon,
} from "lucide-react";
import { roleName, memberStatusBadge } from "@/lib/org-utils";
import { courseStatusBadge } from "@/lib/course-utils";
import { CreateOrgDialog } from "@/app/dashboard/organizations/create-org-dialog";
import {
  RECENT_ACCESS_COOKIE,
  parseRecentAccessCookie,
  type RecentAccessEntry,
} from "@/lib/recent-access";
import { toUserMessage } from "@/lib/connect-error";
import { StudentProgressSection } from "./student-progress-section";

const ORG_LIMIT = 12;
const COURSES_PER_ORG = 8;
const RECENT_LIMIT = 8;

const CAN_MANAGE = new Set([
  OrganizationRole.OWNER,
  OrganizationRole.ADMIN,
  OrganizationRole.TEACHER,
]);

interface OrganizationChoice {
  member: OrganizationMember;
  org: Organization;
}

function accessTypeLabel(type: RecentAccessEntry["type"]) {
  switch (type) {
    case "dashboard-organizations":
      return "Trang chính · Tổ chức";
    case "dashboard-profile":
      return "Trang chính · Hồ sơ";
    case "organization":
      return "Tổ chức";
    case "organization-courses":
      return "Danh sách khóa học";
    case "organization-members":
      return "Thành viên tổ chức";
    case "course":
      return "Khóa học";
    case "lesson":
      return "Bài học";
    case "admin-users":
      return "Admin · Người dùng";
    case "admin-user":
      return "Admin · Hồ sơ người dùng";
    case "admin-organizations":
      return "Admin · Tổ chức";
    case "admin-organization":
      return "Admin · Chi tiết tổ chức";
    case "admin-organization-members":
      return "Admin · Thành viên tổ chức";
    case "admin-organization-courses":
      return "Admin · Khóa học tổ chức";
    case "admin-course":
      return "Admin · Chi tiết khóa học";
    case "admin-module":
      return "Admin · Chương học";
  }
}

const PROGRESS_LIMIT = 20;

export default async function DashboardPage() {
  const { claims, token } = await requireAnyUser();

  const memberClient = createRichterClient(OrganizationMemberService, token);
  const orgClient = createRichterClient(OrganizationService, token);
  const courseClient = createRichterClient(CourseService, token);
  const interactionClient = createRichterClient(InteractionService, token);

  const [{ members }, cookieStore] = await Promise.all([
    memberClient.listUserMemberships({
      userId: claims.sub,
      limit: ORG_LIMIT,
      offset: 0,
    }),
    cookies(),
  ]);

  const orgResults = await Promise.allSettled(
    members.map((m) =>
      orgClient.getOrganizationById({ id: m.organizationId }).then((r) => r.organization),
    ),
  );

  const organizations = members.flatMap((member, i): OrganizationChoice[] => {
    const orgResult = orgResults[i];
    const org = orgResult?.status === "fulfilled" ? orgResult.value : undefined;
    return org ? [{ member, org }] : [];
  });

  const activeOrganizations = organizations.filter(
    ({ member }) => member.status === MemberStatus.ACTIVE,
  );

  const courseResults = await Promise.allSettled(
    activeOrganizations.map(({ org }) =>
      courseClient
        .listCourses({ organizationId: org.id, limit: COURSES_PER_ORG, offset: 0 })
        .then((r) => (r.courses ?? []).map((course) => ({ course, org }))),
    ),
  );

  const courseItems = courseResults.flatMap((result) =>
    result.status === "fulfilled" ? result.value : [],
  );

  const accessibleOrgSlugs = new Set(activeOrganizations.map(({ org }) => org.slug));
  const canSeeAdminAccess = claims.role === UserRole.ADMIN;
  const recentAccess = parseRecentAccessCookie(
    cookieStore.get(RECENT_ACCESS_COOKIE)?.value,
  )
    .filter((entry) => {
      if (entry.userId !== claims.sub) return false;
      if (entry.area === "admin") return canSeeAdminAccess;
      if (entry.type === "dashboard-organizations" || entry.type === "dashboard-profile") return true;
      return entry.orgSlug ? accessibleOrgSlugs.has(entry.orgSlug) : false;
    })
    .slice(0, RECENT_LIMIT);

  const manageableOrgCount = activeOrganizations.filter(({ member }) => CAN_MANAGE.has(member.role)).length;
  const publishedCourseCount = courseItems.filter(({ course }) => course.status === CourseStatus.PUBLISHED).length;
  const recentCourses = courseItems.slice(0, 4);

  const isStudent = manageableOrgCount === 0;

  let myCourseProgress: MyCourseProgress[] = [];
  let progressErrorMsg: string | undefined;
  if (isStudent) {
    try {
      const { courses } = await interactionClient.listMyCourseProgress({
        limit: PROGRESS_LIMIT,
        offset: 0,
      });
      myCourseProgress = courses;
    } catch (err) {
      progressErrorMsg = toUserMessage(err);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <div className="flex flex-col gap-4 border-b pb-5 md:flex-row md:items-end md:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            Xin chào, {displayName(claims)}
          </h1>
          <p className="text-sm text-muted-foreground">
            Tổng quan tài khoản, tổ chức và các trang bạn vừa truy cập.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <CreateOrgDialog token={token} userId={claims.sub} />
          <Button variant="outline" asChild className="gap-2">
            <Link href="/dashboard/profile">
              <UserIcon className="size-4" />
              Hồ sơ
            </Link>
          </Button>
        </div>
      </div>

      {/* KPI stats — uniform static cards (navigation lives in the sidebar). */}
      <div className="grid gap-3 md:grid-cols-4">
        <div className="rounded-md border p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <BuildingIcon className="size-4" />
            Tổ chức
          </div>
          <p className="mt-2 text-2xl font-semibold">{activeOrganizations.length}</p>
        </div>
        <div className="rounded-md border p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <GraduationCapIcon className="size-4" />
            Khóa học
          </div>
          <p className="mt-2 text-2xl font-semibold">{courseItems.length}</p>
        </div>
        <div className="rounded-md border p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <BookOpenIcon className="size-4" />
            Đã xuất bản
          </div>
          <p className="mt-2 text-2xl font-semibold">{publishedCourseCount}</p>
        </div>
        {isStudent ? (
          /* Students see their overall avg score in the 4th card slot */
          <div className="rounded-md border p-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <GraduationCapIcon className="size-4" />
              Khóa học đang học
            </div>
            <p className="mt-2 text-2xl font-semibold">{myCourseProgress.length}</p>
          </div>
        ) : (
          <div className="rounded-md border p-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <ShieldCheckIcon className="size-4" />
              Có quyền quản lý
            </div>
            <p className="mt-2 text-2xl font-semibold">{manageableOrgCount}</p>
          </div>
        )}
      </div>

      {isStudent && (
        <StudentProgressSection
          courses={myCourseProgress}
          errorMsg={progressErrorMsg}
        />
      )}

      <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-base font-semibold">Truy cập gần đây</h2>
              <Button variant="ghost" size="sm" asChild className="gap-1.5">
                <Link href="/dashboard/organizations">
                  Tất cả tổ chức
                  <ArrowRightIcon className="size-3.5" />
                </Link>
              </Button>
            </div>

            <div className="rounded-md border">
              {recentAccess.length === 0 ? (
                <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
                  <Clock3Icon className="size-8 text-muted-foreground/60" />
                  <p className="text-sm font-medium">Chưa có truy cập gần đây</p>
                  <p className="max-w-md text-sm text-muted-foreground">
                    Mở một tổ chức, khóa học hoặc bài học để danh sách này được cập nhật theo lượt truy cập thật.
                  </p>
                </div>
              ) : (
                <div className="divide-y">
                  {recentAccess.map((entry) => (
                    <Link
                      key={`${entry.id}:${entry.accessedAt}`}
                      href={entry.href}
                      className="grid gap-3 px-4 py-3 transition-colors hover:bg-muted/50 md:grid-cols-[minmax(0,1fr)_auto]"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{entry.title}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {accessTypeLabel(entry.type)}
                          {entry.subtitle ? ` · ${entry.subtitle}` : ""}
                        </p>
                      </div>
                      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-primary">
                        Mở lại
                        <ArrowRightIcon className="size-3.5" />
                      </span>
                    </Link>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <h2 className="text-base font-semibold">Khóa học trong các tổ chức</h2>
            <div className="rounded-md border">
              {recentCourses.length === 0 ? (
                <p className="px-4 py-8 text-center text-sm text-muted-foreground">
                  Chưa có khóa học nào trong các tổ chức đang hoạt động.
                </p>
              ) : (
                <div className="divide-y">
                  {recentCourses.map(({ course, org }) => (
                    <Link
                      key={course.id}
                      href={`/dashboard/organizations/${org.slug}/courses/${course.id}`}
                      className="grid gap-3 px-4 py-3 transition-colors hover:bg-muted/50 md:grid-cols-[minmax(0,1fr)_auto]"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{course.title}</p>
                        <p className="truncate text-xs text-muted-foreground">{org.name}</p>
                      </div>
                      <div className="flex items-center gap-2 md:justify-end">
                        {courseStatusBadge(course.status)}
                        <ArrowRightIcon className="size-3.5 text-muted-foreground" />
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        <aside className="flex flex-col gap-3">
          <h2 className="text-base font-semibold">Tổ chức</h2>
          <div className="rounded-md border">
            {organizations.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-muted-foreground">
                Bạn chưa tham gia tổ chức nào.
              </p>
            ) : (
              <div className="divide-y">
                {organizations.slice(0, 6).map(({ member, org }) => (
                  <Link
                    key={org.id}
                    href={`/dashboard/organizations/${org.slug}`}
                    className="block px-4 py-3 transition-colors hover:bg-muted/50"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{org.name}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {roleName(member.role)}
                        </p>
                      </div>
                      {memberStatusBadge(member.status)}
                    </div>
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
