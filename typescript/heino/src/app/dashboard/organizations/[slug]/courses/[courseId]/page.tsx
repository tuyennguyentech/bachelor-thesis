// Course Workspace — full-screen, escapes org (sidebar) layout
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAnyUser, requireOrgMember } from "@/lib/auth";
import { createRichterClient } from "@/lib/connect-client";
import { OrganizationService } from "buf/gen/richter/v1/organizations_pb";
import { CourseService, CourseModuleService, LessonService, type CourseModule, type Lesson } from "buf/gen/richter/v1/courses_pb";
import { CourseMemberService, CourseRole, type CourseMember } from "buf/gen/richter/v1/course_members_pb";
import { InteractionService } from "buf/gen/richter/v1/interactions_pb";
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
import {
  BuildingIcon,
  LogOutIcon,
  ChevronLeftIcon,
  BookOpenIcon,
  UsersIcon,
  ClockIcon,
  GraduationCapIcon,
  CheckCircle2,
} from "lucide-react";
import { ModeToggle } from "@/components/mode-toggle";
import { logout } from "@/app/actions/auth";
import { courseStatusBadge } from "@/lib/course-utils";
import { EditCourseForm } from "@/app/admin/organizations/[slug]/courses/[courseId]/edit-course-form";
import { CourseStatusSelect } from "@/app/admin/organizations/[slug]/courses/[courseId]/course-status-select";
import { DeleteCourseButton } from "@/app/admin/organizations/[slug]/courses/[courseId]/delete-course-button";
import { AddModuleDialog } from "@/app/admin/organizations/[slug]/courses/[courseId]/add-module-dialog";
import { ModuleActions } from "@/app/admin/organizations/[slug]/courses/[courseId]/module-actions";
import { AddLessonDialog } from "@/app/admin/organizations/[slug]/courses/[courseId]/modules/[moduleId]/add-lesson-dialog";
import { LessonActions } from "@/app/admin/organizations/[slug]/courses/[courseId]/modules/[moduleId]/lesson-actions";
import { RecentAccessRecorder } from "@/components/dashboard/recent-access-recorder";
import { EmptyState } from "@/components/ui/empty-state";
import { Pagination } from "@/components/pagination";
import { CourseResults } from "./course-results";
import { AddCourseMemberDialog } from "./add-course-member-dialog";
import { CourseMemberActionsMenu } from "./course-member-actions-menu";
import { CourseWorkspaceSidebar, type CourseTab } from "./course-workspace";
import { CourseLockScreen } from "./course-lock-screen";
import { JoinRequestsTab } from "./join-requests-tab";
import { QuickCreateTrigger } from "@/components/dashboard/quick-create/QuickCreateTrigger";

const CAN_MANAGE_ORG_ROLES = [OrganizationRole.OWNER, OrganizationRole.ADMIN, OrganizationRole.TEACHER];
const CAN_CHANGE_STATUS = [OrganizationRole.OWNER, OrganizationRole.ADMIN];
const MEMBERS_LIMIT = 50;

// Strip a redundant "Bài N:" / "Bài N." / "Bài N -" prefix from a lesson title,
// since the row already renders its own ordinal number.
function stripLessonPrefix(title: string): string {
  return title.replace(/^\s*Bài\s+\d+\s*[:.\-–]\s*/i, "").trim() || title;
}

function courseRoleBadge(role: CourseRole) {
  if (role === CourseRole.TEACHER)
    return <Badge variant="outline" className="border-blue-500 text-blue-600">Giảng viên</Badge>;
  if (role === CourseRole.STUDENT)
    return <Badge variant="outline">Học viên</Badge>;
  return <Badge variant="secondary">Không xác định</Badge>;
}

export default async function CourseWorkspacePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; courseId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug, courseId } = await params;
  const sp = await searchParams;
  const rawTab = (Array.isArray(sp.tab) ? sp.tab[0] : sp.tab) ?? "overview";
  const activeTab: CourseTab = (["overview", "lessons", "members", "results", "join-requests"] as CourseTab[]).includes(rawTab as CourseTab)
    ? (rawTab as CourseTab)
    : "overview";

  const membersPage = Math.max(1, parseInt((Array.isArray(sp.page) ? sp.page[0] : sp.page) ?? "1", 10) || 1);
  const membersOffset = (membersPage - 1) * MEMBERS_LIMIT;

  const { claims, token } = await requireAnyUser();

  // ── Fetch org ──────────────────────────────────────────────────────────────
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
  const canManageViaOrg = CAN_MANAGE_ORG_ROLES.includes(member.role);
  const canChangeStatus = CAN_CHANGE_STATUS.includes(member.role);

  // ── Fetch course ───────────────────────────────────────────────────────────
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

  // Course owner can also manage (regardless of org role)
  const isCourseOwner = course.ownerId === claims.sub;
  const canManage = canManageViaOrg || isCourseOwner;

  // ── Fetch my join request status if locked ──────────────────────────────────
  let joinRequest = null;
  if (!course.canAccess && !canManage) {
    const memberClient = createRichterClient(CourseMemberService, token);
    try {
      const res = await memberClient.getMyJoinRequestStatus({ courseId: course.id });
      joinRequest = res.request ?? null;
    } catch (err) {
      console.error("Failed to fetch join request status:", err);
    }
  }

  // ── Fetch modules + lessons (always needed for sidebar, only if having access) ────────
  let modulesWithLessons: (CourseModule & { lessons: Lesson[] })[] = [];
  let totalMembersCount = 0;
  let membersCountKnown = false;
  // Lessons the current student has attempted at least once (student view only).
  const completedLessonIds = new Set<string>();
  if (course.canAccess || canManage) {
    const moduleClient = createRichterClient(CourseModuleService, token);
    const lessonClient = createRichterClient(LessonService, token);
    const memberClient = createRichterClient(CourseMemberService, token);

    // Member count is supplementary: fetch it independently so a failure does not
    // wipe out modules/lessons. Proto enforces limit lte:100.
    const membersPromise = memberClient
      .listCourseMembers({ courseId: course.id, limit: 100, offset: 0 })
      .then((res) => {
        totalMembersCount = res.members?.length ?? 0;
        membersCountKnown = true;
      })
      .catch((err) => {
        console.error("Failed to fetch course members count:", err);
      });

    try {
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
      modulesWithLessons = modules.map((m) => ({ ...m, lessons: lessonsByModule.get(m.id) ?? [] }));

      // For students, resolve which lessons have at least one attempt. No bulk RPC
      // exists, so fan out GetMyAttempt once per lesson in a single batch.
      if (!canManage && allLessons.length > 0) {
        const interactionClient = createRichterClient(InteractionService, token);
        await Promise.all(
          allLessons.map((l) =>
            interactionClient
              .getMyAttempt({ lessonId: l.id })
              .then((res) => {
                if (res.attempt) completedLessonIds.add(l.id);
              })
              .catch(() => {}),
          ),
        );
      }
    } catch (err) {
      console.error("Failed to fetch modules and lessons:", err);
    }

    await membersPromise;
  }

  // ── Fetch members (tab=members) ────────────────────────────────────────────
  let members: CourseMember[] = [];
  let membersHasNext = false;
  if (activeTab === "members" && (course.canAccess || canManage)) {
    const memberClient = createRichterClient(CourseMemberService, token);
    try {
      const res = await memberClient.listCourseMembers({
        courseId: course.id,
        limit: MEMBERS_LIMIT,
        offset: membersOffset,
      });
      members = res.members ?? [];
    } catch (err) {
      console.error("Failed to fetch course members:", err);
      members = [];
    }
    membersHasNext = members.length === MEMBERS_LIMIT;
  }

  // ── Fetch pending join requests (tab=join-requests) ───────────────────────
  let pendingRequests: any[] = [];
  if (activeTab === "join-requests" && canManage) {
    const memberClient = createRichterClient(CourseMemberService, token);
    try {
      const res = await memberClient.listPendingJoinRequests({
        courseId: course.id,
        limit: 100,
        offset: 0,
      });
      pendingRequests = res.requests ?? [];
    } catch (err) {
      console.error("Failed to fetch pending requests:", err);
    }
  }

  const redirectAfterDelete = `/dashboard/organizations/${slug}/courses`;

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      <RecentAccessRecorder
        exactPath
        entry={{
          userId: claims.sub,
          id: `course:${course.id}`,
          type: "course",
          orgSlug: slug,
          title: course.title,
          subtitle: org.name,
          href: `/dashboard/organizations/${slug}/courses/${course.id}`,
        }}
      />

      {/* ── Header ── */}
      <header className="flex h-14 shrink-0 items-center justify-between border-b bg-card px-4 lg:px-6 z-10">
        <div className="flex min-w-0 items-center gap-3">
          <Button variant="ghost" size="sm" asChild className="gap-1 px-2">
            <Link href={`/dashboard/organizations/${slug}`}>
              <ChevronLeftIcon className="size-4" />
              <span className="hidden sm:inline">Tổ chức</span>
            </Link>
          </Button>
          <div className="hidden h-5 w-px bg-border sm:block" />
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <BuildingIcon className="size-3.5 text-muted-foreground" />
              <span>{org.name}</span>
            </div>
            <p className="truncate text-sm font-semibold">{course.title}</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <ModeToggle />
          <form action={logout}>
            <Button variant="ghost" size="sm" type="submit" className="gap-2">
              <LogOutIcon className="size-4" />
              <span className="hidden sm:inline">Đăng xuất</span>
            </Button>
          </form>
        </div>
      </header>

      {/* ── Body: sidebar + main ── */}
      {(!course.canAccess && !canManage) ? (
        <main className="flex-1 min-w-0 overflow-auto bg-background">
          <CourseLockScreen
            slug={slug}
            courseId={courseId}
            courseTitle={course.title}
            courseDescription={course.description}
            joinRequest={joinRequest}
          />
        </main>
      ) : (
        <div className="flex flex-col md:flex-row flex-1 min-h-0 overflow-hidden bg-background">
          <CourseWorkspaceSidebar
            slug={slug}
            courseId={courseId}
            courseTitle={course.title}
            activeTab={activeTab}
            canManage={canManage}
          />

          <main className="flex-1 min-w-0 overflow-auto p-4 lg:p-6 bg-background">

            {/* ── Tab: Tổng quan ── */}
            {activeTab === "overview" && (
              <div className="flex flex-col gap-6 max-w-screen-2xl">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex flex-col gap-1">
                    <h1 className="text-xl font-semibold">{course.title}</h1>
                    {course.description && (
                      <p className="text-sm text-muted-foreground">{course.description}</p>
                    )}
                  </div>
                  {canManage && courseStatusBadge(course.status)}
                </div>

                {/* ── COURSE STATISTICS GRID ── */}
                <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 md:grid-cols-4 bg-muted/20 p-4 rounded-xl border">
                  <div className="flex flex-col gap-1.5 p-4 min-w-0 bg-card rounded-lg border shadow-sm">
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <BookOpenIcon className="size-4 text-blue-500" />
                      <span className="text-xs font-medium">Chương học</span>
                    </div>
                    <div className="flex items-baseline flex-wrap gap-1 mt-1">
                      <span className="text-2xl font-bold tracking-tight text-foreground">{modulesWithLessons.length}</span>
                      <span className="text-xs text-muted-foreground">chương</span>
                    </div>
                  </div>
                  <div className="flex flex-col gap-1.5 p-4 min-w-0 bg-card rounded-lg border shadow-sm">
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <GraduationCapIcon className="size-4 text-emerald-500" />
                      <span className="text-xs font-medium">Bài học</span>
                    </div>
                    <div className="flex items-baseline flex-wrap gap-1 mt-1">
                      <span className="text-2xl font-bold tracking-tight text-foreground">
                        {modulesWithLessons.reduce((acc, m) => acc + m.lessons.length, 0)}
                      </span>
                      <span className="text-xs text-muted-foreground">bài học</span>
                    </div>
                  </div>
                  <div className="flex flex-col gap-1.5 p-4 min-w-0 bg-card rounded-lg border shadow-sm">
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <ClockIcon className="size-4 text-indigo-500" />
                      <span className="text-xs font-medium">Thời lượng video</span>
                    </div>
                    <div className="flex items-baseline flex-wrap gap-1 mt-1">
                      <span className="text-2xl font-bold tracking-tight text-foreground">
                        {Math.round(
                          modulesWithLessons.reduce(
                            (acc, m) =>
                              acc +
                              m.lessons.reduce((sum, l) => sum + (l.durationSeconds || 0), 0),
                            0
                          ) / 60
                        )}
                      </span>
                      <span className="text-xs text-muted-foreground">phút</span>
                    </div>
                  </div>
                  {(canManage || membersCountKnown) && (
                    <div className="flex flex-col gap-1.5 p-4 min-w-0 bg-card rounded-lg border shadow-sm">
                      <div className="flex items-center gap-2 text-muted-foreground">
                        <UsersIcon className="size-4 text-amber-500" />
                        <span className="text-xs font-medium">Thành viên</span>
                      </div>
                      <div className="flex items-baseline flex-wrap gap-1 mt-1">
                        <span className="text-2xl font-bold tracking-tight text-foreground">{totalMembersCount}</span>
                        <span className="text-xs text-muted-foreground font-normal">người</span>
                      </div>
                    </div>
                  )}
                </div>

                {canManage && (
                  <>
                    <div className="rounded-md border p-4 flex flex-col gap-4 bg-background">
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

                    <div className="rounded-md border p-4 flex items-center justify-between gap-4 bg-background">
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

                {/* Danger zone — only for owner/admin */}
                {canChangeStatus && (
                  <div className="rounded-md border border-destructive/30 p-4 flex items-center justify-between bg-background">
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
            )}

            {/* ── Tab: Bài học ── */}
            {activeTab === "lessons" && (
              <div className="flex flex-col gap-4 max-w-screen-2xl">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <BookOpenIcon className="size-4 text-muted-foreground" />
                    <h1 className="font-semibold">
                      Nội dung ({modulesWithLessons.length} chương)
                    </h1>
                  </div>
                  {canManage && (
                    <div className="flex items-center gap-2">
                      <QuickCreateTrigger
                        token={token}
                        modules={modulesWithLessons}
                        courseId={course.id}
                        slug={slug}
                      />
                      <AddModuleDialog courseId={course.id} slug={slug} nextOrder={modulesWithLessons.length} token={token} />
                    </div>
                  )}
                </div>

                {modulesWithLessons.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-8 text-center">
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

                        {m.lessons.map((lesson, li) => {
                          const durationMinutes = Math.round((lesson.durationSeconds || 0) / 60);
                          const isCompleted = !canManage && completedLessonIds.has(lesson.id);
                          return (
                            <div
                              key={lesson.id}
                              className="flex items-center justify-between gap-2 px-4 py-2 ml-4 rounded-md border bg-background"
                            >
                              <Link
                                href={`/dashboard/organizations/${slug}/courses/${courseId}/lessons/${lesson.id}`}
                                className="flex items-center gap-2 flex-1 min-w-0 hover:opacity-80"
                              >
                                <span className="text-sm text-muted-foreground font-mono w-6">{li + 1}.</span>
                                {isCompleted && (
                                  <CheckCircle2 className="size-4 shrink-0 text-emerald-500" />
                                )}
                                <div className="flex flex-col min-w-0">
                                  <span className="text-sm truncate">{stripLessonPrefix(lesson.title)}</span>
                                  {lesson.description && (
                                    <span className="text-xs text-muted-foreground truncate">{lesson.description}</span>
                                  )}
                                </div>
                              </Link>
                              <div className="flex items-center gap-2 shrink-0">
                                {lesson.durationSeconds > 0 ? (
                                  <Badge variant="secondary" className="gap-1 font-normal tabular-nums">
                                    <ClockIcon className="size-3" />~{Math.max(1, durationMinutes)} phút
                                  </Badge>
                                ) : (
                                  <Badge variant="outline" className="font-normal text-muted-foreground">
                                    Chưa có nội dung
                                  </Badge>
                                )}
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
                            </div>
                          );
                        })}

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
            )}

            {/* ── Tab: Thành viên ── */}
            {activeTab === "members" && (
              <div className="flex flex-col gap-4 max-w-screen-2xl">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <UsersIcon className="size-4 text-muted-foreground" />
                    <h1 className="font-semibold">Thành viên khóa học</h1>
                  </div>
                  {canManage && (
                    <AddCourseMemberDialog courseId={course.id} token={token} />
                  )}
                </div>
                <p className="text-sm text-muted-foreground -mt-2">
                  Danh sách người dùng đang tham gia khóa học &ldquo;{course.title}&rdquo;.
                </p>

                <div className="rounded-md border bg-background overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Thành viên</TableHead>
                        <TableHead>Vai trò</TableHead>
                        <TableHead>Ngày tham gia</TableHead>
                        {canManage && <TableHead className="w-12" />}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {members.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={canManage ? 4 : 3} className="p-0">
                            <EmptyState
                              icon={<UsersIcon className="size-5" />}
                              title="Chưa có thành viên"
                              description={
                                canManage
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
                              {canManage && (
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
                  page={membersPage}
                  hasNext={membersHasNext}
                  buildHref={(p) =>
                    `/dashboard/organizations/${slug}/courses/${courseId}?tab=members&page=${p}`
                  }
                />
              </div>
            )}

            {/* ── Tab: Duyệt yêu cầu ── */}
            {activeTab === "join-requests" && (
              <div className="flex flex-col gap-4 max-w-screen-2xl">
                {canManage ? (
                  <JoinRequestsTab
                    slug={slug}
                    courseId={course.id}
                    requests={pendingRequests}
                  />
                ) : (
                  <div className="rounded-md border p-6 text-center text-sm text-muted-foreground bg-background">
                    Bạn không có quyền duyệt yêu cầu của khóa học này.
                  </div>
                )}
              </div>
            )}

            {/* ── Tab: Kết quả học tập ── */}
            {activeTab === "results" && (
              <div className="flex flex-col gap-4 max-w-screen-2xl">
                {canManage ? (
                  <>
                    <h1 className="font-semibold">Kết quả học viên</h1>
                    <div className="overflow-x-auto">
                      <CourseResults courseId={course.id} token={token} />
                    </div>
                  </>
                ) : (
                  <div className="rounded-md border p-6 text-center text-sm text-muted-foreground bg-background">
                    Bạn không có quyền xem kết quả học tập của khóa học này.
                  </div>
                )}
              </div>
            )}

          </main>
        </div>
      )}
    </div>
  );
}
