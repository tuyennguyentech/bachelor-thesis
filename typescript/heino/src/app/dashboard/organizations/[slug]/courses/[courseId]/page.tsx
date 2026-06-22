// Course Workspace — full-screen, escapes org (sidebar) layout
import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAnyUser, requireOrgMember } from "@/lib/auth";
import { createRichterClient } from "@/lib/connect-client";
import { OrganizationService } from "buf/gen/richter/v1/organizations_pb";
import { CourseService, CourseModuleService, LessonService, type CourseModule, type Lesson } from "buf/gen/richter/v1/courses_pb";
import { CourseMemberService, CourseRole, type CourseMember, type CourseJoinRequest } from "buf/gen/richter/v1/course_members_pb";
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
  PlayIcon,
  BarChart2Icon,
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
import { cookies } from "next/headers";
import { parseRecentAccessCookie, RECENT_ACCESS_COOKIE } from "@/lib/recent-access";
import { EmptyState } from "@/components/ui/empty-state";
import { Pagination } from "@/components/pagination";
import { InfoHint } from "@/components/ui/info-hint";
import { CourseResults } from "./course-results";
import { CourseClassPulse, CourseClassPulseSkeleton } from "./course-class-pulse";
import { AddCourseMemberDialog } from "./add-course-member-dialog";
import { CourseMemberActionsMenu } from "./course-member-actions-menu";
import { CourseWorkspaceSidebar, type CourseTab } from "./course-workspace";
import { CourseLockScreen } from "./course-lock-screen";
import { JoinRequestsTab } from "./join-requests-tab";
import { CourseModeToggle } from "./course-mode-toggle";
import { QuickCreateTrigger } from "@/components/dashboard/quick-create/QuickCreateTrigger";
import { StudentProgressCard, type ModuleProgress } from "./student-progress-card";

// Org roles that grant course-management bypass on their OWN, matching the
// backend RequireCourseMember/requireCourseManager rules: only org OWNER/ADMIN
// (and the course owner / sys-admin) bypass. An org TEACHER does NOT manage a
// course by org-role alone — they manage only courses they OWN or are an
// explicit course-manager (TEACHER) member of. This keeps the FE consistent
// with backend authz (an org-teacher on a non-member course is locked, not a
// broken manage view).
const CAN_MANAGE_ORG_ROLES = [OrganizationRole.OWNER, OrganizationRole.ADMIN];
// Org-level teachers (and above) may request the manager (TEACHER) role on a
// locked course; a plain learner can only ask to learn (STUDENT).
const CAN_REQUEST_MANAGER_ORG_ROLES = [OrganizationRole.OWNER, OrganizationRole.ADMIN, OrganizationRole.TEACHER];
const CAN_CHANGE_STATUS = [OrganizationRole.OWNER, OrganizationRole.ADMIN];
const MEMBERS_LIMIT = 50;

// Strip a redundant "Bài N:" / "Bài N." / "Bài N -" prefix from a lesson title,
// since the row already renders its own ordinal number.
function stripLessonPrefix(title: string): string {
  return title.replace(/^\s*Bài\s+\d+\s*[:.\-–]\s*/i, "").trim() || title;
}

// Compact Vietnamese relative time (e.g. "5 phút trước") for the "resume" card.
function relativeViTime(ms: number): string {
  const min = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (min < 1) return "vừa xong";
  if (min < 60) return `${min} phút trước`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} giờ trước`;
  return `${Math.round(hr / 24)} ngày trước`;
}

function courseRoleBadge(role: CourseRole, isOwner: boolean) {
  if (isOwner)
    return <Badge variant="outline" className="border-violet-500 text-violet-600">Chủ khóa học</Badge>;
  if (role === CourseRole.TEACHER)
    return <Badge variant="outline" className="border-blue-500 text-blue-600">Quản lý</Badge>;
  if (role === CourseRole.STUDENT)
    return <Badge variant="outline">Thành viên</Badge>;
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

  const rawSub = (Array.isArray(sp.sub) ? sp.sub[0] : sp.sub) ?? "list";
  const validSubs = ["list", "distribution", "scatter", "at-risk"] as const;
  type ResultsSub = (typeof validSubs)[number];
  const resultsSub: ResultsSub =
    validSubs.includes(rawSub as ResultsSub) ? (rawSub as ResultsSub) : "list";

  const membersPage = Math.max(1, parseInt((Array.isArray(sp.page) ? sp.page[0] : sp.page) ?? "1", 10) || 1);
  const membersOffset = (membersPage - 1) * MEMBERS_LIMIT;

  // Course-level "Vào học" signal. `mode=learn` renders the course→lesson flow
  // as a student would see it (read-only list + progress, real persisted
  // attempts). Only meaningful for a manager; a plain student is always a
  // learner. Distinct from a lesson's `?preview=1` (non-persisted quick peek).
  const rawMode = Array.isArray(sp.mode) ? sp.mode[0] : sp.mode;

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

  // ── Resolve my OWN course membership (presence + role) ──────────────────────
  // Exact and page-independent (unlike scanning listCourseMembers). Drives both
  // canManage (course-manager membership) and the first-entry vs re-entry CTA.
  let isCourseMember = false;
  let isCourseManagerMember = false;
  {
    const memberClient = createRichterClient(CourseMemberService, token);
    try {
      const res = await memberClient.getMyCourseMembership({ courseId: course.id });
      isCourseMember = res.isMember;
      isCourseManagerMember = res.isMember && res.role === CourseRole.TEACHER;
    } catch (err) {
      console.error("Failed to resolve self-membership:", err);
    }
  }

  // Course owner can also manage (regardless of org role)
  const isCourseOwner = course.ownerId === claims.sub;
  // canManage matches the backend: course owner, org OWNER/ADMIN, or an explicit
  // course-manager (TEACHER) member. An org TEACHER who is not a course member
  // is NOT a manager here — they are locked and use the request-to-manage flow.
  const canManage = isCourseOwner || canManageViaOrg || isCourseManagerMember;
  const canRequestManager = CAN_REQUEST_MANAGER_ORG_ROLES.includes(member.role);

  // A manager in "learn mode" is a REAL student for rendering/persistence: NOT
  // a manager view (no Studio) and NOT a preview (attempts persist). Only a
  // manager can toggle this; a plain student is already a learner.
  const learnMode = canManage && rawMode === "learn";
  // When a manager is in learn mode, render exactly as a student would see it.
  const renderAsManager = canManage && !learnMode;

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
  // Lessons the current student has attempted at least once (student view only),
  // plus running score totals accumulated from the same getMyAttempt fan-out so
  // the overview can show personal progress + average score without extra RPCs.
  const completedLessonIds = new Set<string>();
  let myScoreSum = 0;
  let myMaxScoreSum = 0;
  // Per-module score totals (for per-chapter mastery) + a per-lesson score trend
  // (for the "am I improving?" sparkline) — both from the same getMyAttempt fan-out.
  const moduleScore = new Map<string, { score: number; max: number }>();
  const lessonTrend: { lessonId: string; title: string; lessonNumber: number; moduleTitle: string; frac: number; when: number }[] = [];
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

      // Module title by id — so the score-trend tooltip can name the chapter a
      // lesson belongs to (not just an ordinal).
      const moduleTitleById = new Map<string, string>(modules.map((m) => [m.id, m.title]));
      // Lesson NUMBER (1-based position within its chapter) by id — so the
      // score-trend tooltip can say "Bài 3" (the real lesson, as numbered in the
      // Bài học tab), not the submission-order index the X axis already shows.
      const lessonNumberById = new Map<string, number>();
      for (const m of modulesWithLessons) {
        m.lessons.forEach((l, li) => lessonNumberById.set(l.id, li + 1));
      }

      // For students (incl. a manager in learn mode), resolve which lessons have
      // at least one attempt. No bulk RPC exists, so fan out GetMyAttempt once
      // per lesson in a single batch.
      if (!renderAsManager && allLessons.length > 0) {
        const interactionClient = createRichterClient(InteractionService, token);
        await Promise.all(
          allLessons.map((l) =>
            interactionClient
              .getMyAttempt({ lessonId: l.id })
              .then((res) => {
                if (res.attempt) {
                  completedLessonIds.add(l.id);
                  if (res.attempt.maxScore > 0) {
                    myScoreSum += res.attempt.totalScore;
                    myMaxScoreSum += res.attempt.maxScore;
                    const ms = moduleScore.get(l.moduleId) ?? { score: 0, max: 0 };
                    ms.score += res.attempt.totalScore;
                    ms.max += res.attempt.maxScore;
                    moduleScore.set(l.moduleId, ms);
                    lessonTrend.push({
                      lessonId: l.id,
                      title: stripLessonPrefix(l.title),
                      lessonNumber: lessonNumberById.get(l.id) ?? 0,
                      moduleTitle: moduleTitleById.get(l.moduleId) ?? "",
                      frac: res.attempt.totalScore / res.attempt.maxScore,
                      when: res.attempt.submittedAt ? Number(res.attempt.submittedAt.seconds) : 0,
                    });
                  }
                }
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

  // ── Derived overview metrics ───────────────────────────────────────────────
  const totalLessons = modulesWithLessons.reduce((acc, m) => acc + m.lessons.length, 0);
  const totalVideoMinutes = Math.round(
    modulesWithLessons.reduce(
      (acc, m) => acc + m.lessons.reduce((sum, l) => sum + (l.durationSeconds || 0), 0),
      0,
    ) / 60,
  );
  // Learner-only figures (meaningful when rendering as a student / learn-mode).
  const myLessonsDone = completedLessonIds.size;
  const myProgressPct = totalLessons > 0 ? Math.round((myLessonsDone / totalLessons) * 100) : 0;
  const myAvgScorePct = myMaxScoreSum > 0 ? Math.round((myScoreSum / myMaxScoreSum) * 100) : null;
  // First lesson the learner has not attempted yet — the "continue learning" target.
  const nextLesson =
    modulesWithLessons.flatMap((m) => m.lessons).find((l) => !completedLessonIds.has(l.id)) ?? null;

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
  let pendingRequests: CourseJoinRequest[] = [];
  if (activeTab === "join-requests" && renderAsManager) {
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

  // Lesson links carry `mode=learn` so a manager who entered learn mode stays a
  // real student on the lesson page (real StudentLessonView + persisted submit).
  const lessonHref = (lessonId: string) =>
    `/dashboard/organizations/${slug}/courses/${courseId}/lessons/${lessonId}${learnMode ? "?mode=learn" : ""}`;

  // "Resume" target for the overview card: the lesson this user opened most
  // recently in THIS course (from the recent-access cookie), else the next
  // un-attempted lesson (learner), else the first lesson.
  const cookieStore = await cookies();
  const recentLesson = parseRecentAccessCookie(cookieStore.get(RECENT_ACCESS_COOKIE)?.value)
    .filter(
      (e) =>
        e.userId === claims.sub &&
        e.type === "lesson" &&
        e.href.includes(`/courses/${courseId}/lessons/`),
    )
    .sort((a, b) => b.accessedAt - a.accessedAt)[0];
  const firstLesson = modulesWithLessons.flatMap((m) => m.lessons)[0] ?? null;
  const fallbackLesson = nextLesson ?? firstLesson;
  const resumeTarget = recentLesson
    ? {
        // The recorded href has no query; preserve learn-mode for a manager.
        href: `${recentLesson.href}${learnMode ? "?mode=learn" : ""}`,
        title: stripLessonPrefix(recentLesson.title),
        when: relativeViTime(recentLesson.accessedAt),
        isResume: true,
      }
    : fallbackLesson
      ? {
          href: lessonHref(fallbackLesson.id),
          title: stripLessonPrefix(fallbackLesson.title),
          when: null,
          isResume: false,
        }
      : null;
  // Per-module stats for the overview chart. A student sees their own per-chapter
  // PROGRESS (lessons done / total); a manager sees content WEIGHT (lessons + video
  // minutes per chapter). The old chart showed only normalized lesson counts, which
  // duplicated the numbers already printed and conveyed nothing actionable.
  const moduleStats = modulesWithLessons.map((m) => {
    const lessonCount = m.lessons.length;
    const completed = m.lessons.filter((l) => completedLessonIds.has(l.id)).length;
    // Lessons that actually have an uploaded video — "content readiness".
    const withVideo = m.lessons.filter((l) => (l.durationSeconds || 0) > 0).length;
    const durationMin = Math.round(
      m.lessons.reduce((s, l) => s + (l.durationSeconds || 0), 0) / 60,
    );
    const ms = moduleScore.get(m.id);
    // Per-chapter average score (mastery), null until the learner attempts a lesson
    // in the chapter. Distinct from completion: "done all 5 but scored 45%".
    const scoreFrac = ms && ms.max > 0 ? ms.score / ms.max : null;
    return { id: m.id, title: m.title, lessonCount, completed, withVideo, durationMin, scoreFrac };
  });

  // Per-module progress with lesson detail for the interactive student progress card.
  const studentModuleProgress: ModuleProgress[] = modulesWithLessons.map((m) => {
    const ms = moduleScore.get(m.id);
    const scoreFrac = ms && ms.max > 0 ? ms.score / ms.max : null;
    return {
      id: m.id,
      title: m.title,
      lessonCount: m.lessons.length,
      completed: m.lessons.filter((l) => completedLessonIds.has(l.id)).length,
      scoreFrac,
      lessons: m.lessons.map((l) => {
        const lt = lessonTrend.find((t) => t.lessonId === l.id);
        return {
          id: l.id,
          title: l.title,
          completed: completedLessonIds.has(l.id),
          scoreFrac: lt ? lt.frac : null,
        };
      }),
    };
  });
  // Per-lesson score trend in submission order (the "am I improving?" sparkline).
  const scoreTrend = [...lessonTrend]
    .sort((a, b) => a.when - b.when)
    .map((t) => ({ frac: t.frac, lessonId: t.lessonId, lessonTitle: t.title, lessonNumber: t.lessonNumber, moduleTitle: t.moduleTitle }));
  // "Bắt đầu/Tiếp tục học" is a LEARNER call-to-action. A manager in manage mode
  // enters learning via the Vào học | Quản lý toggle, not a resume card — so the
  // card is shown only when rendering as a student (incl. a manager in learn mode).
  // Only surface the standalone resume card when it points at a genuinely RECENT
  // lesson (different from the "next" lesson the progress card already links to).
  // Otherwise it just duplicates the progress card's CTA, so we hide it and let the
  // per-chapter chart span the full width.
  const showResumeCard = !renderAsManager && !!resumeTarget && resumeTarget.isResume;

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
            canRequestManager={canRequestManager}
          />
        </main>
      ) : (
        <div className="flex flex-col md:flex-row flex-1 min-h-0 overflow-hidden bg-background">
          <CourseWorkspaceSidebar
            slug={slug}
            courseTitle={course.title}
            activeTab={activeTab}
            canManage={renderAsManager}
            mode={learnMode ? "learn" : "manage"}
          />

          <main className="flex-1 min-w-0 overflow-auto p-4 lg:p-6 bg-background">

            {/* ── Tab: Tổng quan ── */}
            {activeTab === "overview" && (
              <div className="flex flex-col gap-6 max-w-screen-2xl">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                  <div className="flex flex-col gap-1 min-w-0">
                    <h1 className="text-xl font-semibold">{course.title}</h1>
                    {course.description && (
                      <p className="text-sm text-muted-foreground">{course.description}</p>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-3 sm:shrink-0">
                    {/* Quick-create surfaced on the default (overview) tab so managers
                        discover the "upload video → auto-run pipeline → exercises"
                        flow without first navigating to the Bài học tab. Needs a
                        module to attach the lesson to. */}
                    {renderAsManager && modulesWithLessons.length > 0 && (
                      <QuickCreateTrigger
                        token={token}
                        modules={modulesWithLessons}
                        courseId={course.id}
                        slug={slug}
                      />
                    )}
                    {/* Manager-only: switch between authoring and real learning. */}
                    {canManage && (
                      <CourseModeToggle
                        slug={slug}
                        courseId={course.id}
                        mode={learnMode ? "learn" : "manage"}
                        isMember={isCourseMember}
                      />
                    )}
                    {renderAsManager && courseStatusBadge(course.status)}
                  </div>
                </div>

                {/* Learn-mode banner: a manager is doing REAL, persisted learning. */}
                {learnMode && (
                  <div className="flex items-center gap-2 rounded-md border border-emerald-300 bg-emerald-50 px-4 py-2 text-sm text-emerald-800 dark:border-emerald-700 dark:bg-emerald-950/20 dark:text-emerald-300">
                    <GraduationCapIcon className="size-4 shrink-0" />
                    <span>
                      Bạn đang ở chế độ học. Kết quả làm bài sẽ được lưu lại như học viên thật. Chuyển sang
                      &ldquo;Quản lý&rdquo; để chỉnh sửa nội dung.
                    </span>
                  </div>
                )}

                {/* ── Learner progress + continue-learning (student / learn-mode) ── */}
                {!renderAsManager && totalLessons > 0 && (
                  <StudentProgressCard
                    totalLessons={totalLessons}
                    lessonsDone={myLessonsDone}
                    progressPct={myProgressPct}
                    avgScorePct={myAvgScorePct}
                    scoreTrend={scoreTrend}
                    nextLesson={nextLesson ? { id: nextLesson.id, title: nextLesson.title } : null}
                    moduleProgress={studentModuleProgress}
                    slug={slug}
                    courseId={courseId}
                    learnMode={learnMode}
                  />
                )}

                {/* ── COURSE STATISTICS GRID ── */}
                <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 md:grid-cols-4">
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
                        {totalLessons}
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
                        {totalVideoMinutes}
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

                {/* ── Manager class pulse (engagement at a glance) ── */}
                {renderAsManager && (
                  <Suspense fallback={<CourseClassPulseSkeleton />}>
                    <CourseClassPulse
                      courseId={course.id}
                      token={token}
                      slug={slug}
                      totalMembers={totalMembersCount}
                    />
                  </Suspense>
                )}

                {/* Resume the most recently opened lesson (students who have one).
                    The next-lesson CTA lives in the progress card above; this is the
                    distinct "pick up where you left off" shortcut. */}
                {showResumeCard && resumeTarget && (
                  <div
                    className="rounded-md border bg-background p-4 flex flex-col gap-3"
                    data-testid="course-resume-card"
                  >
                    <div className="flex items-center gap-2">
                      <PlayIcon className="size-4 text-emerald-500" />
                      <h2 className="font-medium">
                        {resumeTarget.isResume ? "Tiếp tục học gần đây" : "Bắt đầu học"}
                      </h2>
                    </div>
                    <div className="flex items-center justify-between gap-3 flex-wrap">
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{resumeTarget.title}</p>
                        {resumeTarget.when && (
                          <p className="text-xs text-muted-foreground">
                            Bạn đã mở {resumeTarget.when}
                          </p>
                        )}
                      </div>
                      <Button asChild className="gap-2 shrink-0">
                        <Link href={resumeTarget.href}>
                          <PlayIcon className="size-4" />
                          {resumeTarget.isResume ? "Tiếp tục" : "Vào học"}
                        </Link>
                      </Button>
                    </div>
                  </div>
                )}

                {/* Content readiness per chapter — MANAGER ONLY. Students already get
                    the richer per-chapter progress in their StudentProgressCard above,
                    so rendering this for them duplicated the "Tiến độ theo chương" box. */}
                {totalLessons > 0 && renderAsManager && (
                  <div
                    className="rounded-md border bg-background p-4 flex flex-col gap-3"
                    data-testid="module-chart"
                  >
                    <div className="flex items-center gap-2">
                      <BarChart2Icon className="size-4 text-muted-foreground" />
                      <h2 className="font-medium">Nội dung theo chương</h2>
                      <InfoHint text="Mức độ sẵn sàng nội dung của mỗi chương: số bài đã có video tải lên trên tổng số bài, kèm tổng thời lượng video." />
                    </div>
                    <div className="flex flex-col gap-2.5">
                      {moduleStats.map((m, mi) => {
                        // "Content readiness" = fraction of the chapter's lessons with an
                        // uploaded video (an empty bar honestly means "no content authored
                        // yet", not a glitch).
                        const pct = m.lessonCount > 0 ? (m.withVideo / m.lessonCount) * 100 : 0;
                        const chapterFull = m.lessonCount > 0 && m.withVideo === m.lessonCount;
                        return (
                          <div key={m.id} className="flex items-center gap-2.5">
                            <span className="text-xs text-muted-foreground w-5 shrink-0 text-right tabular-nums">
                              {mi + 1}
                            </span>
                            <span className="text-xs truncate flex-1 min-w-0" title={m.title}>
                              {m.title}
                            </span>
                            <div className="h-2 w-24 sm:w-36 shrink-0 rounded-full bg-muted overflow-hidden">
                              <div
                                className={`h-full rounded-full ${chapterFull ? "bg-primary" : "bg-primary/60"}`}
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                            <span className="text-xs text-muted-foreground tabular-nums w-32 shrink-0 text-right">
                              {m.withVideo}/{m.lessonCount} bài có video · {m.durationMin} phút
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {renderAsManager && (
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

                {/* Danger zone — only for owner/admin, hidden while learning */}
                {renderAsManager && canChangeStatus && (
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
                  {renderAsManager ? (
                    <div className="flex items-center gap-2">
                      <QuickCreateTrigger
                        token={token}
                        modules={modulesWithLessons}
                        courseId={course.id}
                        slug={slug}
                      />
                      <AddModuleDialog courseId={course.id} slug={slug} nextOrder={modulesWithLessons.length} token={token} />
                    </div>
                  ) : canManage && (
                    <CourseModeToggle
                      slug={slug}
                      courseId={course.id}
                      mode={learnMode ? "learn" : "manage"}
                      isMember={isCourseMember}
                    />
                  )}
                </div>

                {modulesWithLessons.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-8 text-center">
                    {renderAsManager ? "Chưa có chương nào. Thêm chương đầu tiên để bắt đầu." : "Chưa có nội dung."}
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
                          {renderAsManager && (
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
                          const isCompleted = !renderAsManager && completedLessonIds.has(lesson.id);
                          return (
                            <div
                              key={lesson.id}
                              className="flex items-center justify-between gap-2 px-4 py-2 ml-4 rounded-md border bg-background"
                            >
                              <Link
                                href={lessonHref(lesson.id)}
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
                                  // De-emphasized: most lessons start empty, so a heavy badge
                                  // on each row reads as a wall of errors. Keep it a quiet hint.
                                  <span className="text-[11px] italic text-muted-foreground/60">
                                    Chưa có nội dung
                                  </span>
                                )}
                                {renderAsManager && (
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

                        {renderAsManager && (
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
            {activeTab === "members" && (() => {
              // Split into two clearly-labelled groups: managers (course owner +
              // role TEACHER) vs learners (role STUDENT). The course owner is
              // always a manager regardless of their stored row role.
              const managers = members.filter(
                (m) => m.userId === course.ownerId || m.role === CourseRole.TEACHER,
              );
              const learners = members.filter(
                (m) => m.userId !== course.ownerId && m.role === CourseRole.STUDENT,
              );

              const renderRow = (m: CourseMember) => {
                const displayName = `${m.userFirstName} ${m.userLastName}`.trim() || m.userId;
                const isOwner = m.userId === course.ownerId;
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
                    <TableCell>{courseRoleBadge(m.role, isOwner)}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {m.createdAt
                        ? new Date(Number(m.createdAt.seconds) * 1000).toLocaleDateString("vi-VN")
                        : "—"}
                    </TableCell>
                    {renderAsManager && (
                      <TableCell className="text-right">
                        {isOwner ? (
                          <span className="text-xs text-muted-foreground/50">—</span>
                        ) : (
                          <CourseMemberActionsMenu
                            courseId={m.courseId}
                            userId={m.userId}
                            displayName={displayName}
                            token={token}
                          />
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                );
              };

              const renderGroup = (
                rows: CourseMember[],
                title: string,
                description: string,
                emptyText: string,
                testid: string,
                accent: string,
              ) => (
                <div className="flex flex-col gap-2" data-testid={testid}>
                  <div className="flex items-center gap-2">
                    <div className={`h-4 w-1 rounded-full ${accent}`} />
                    <h2 className="text-sm font-semibold">{title}</h2>
                    <Badge variant="secondary" className="font-medium">{rows.length}</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground -mt-1">{description}</p>
                  <div className="rounded-md border bg-background overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Thành viên</TableHead>
                          <TableHead>Vai trò</TableHead>
                          <TableHead>Ngày tham gia</TableHead>
                          {renderAsManager && (
                            <TableHead className="w-12 text-right">
                              <span className="sr-only">Thao tác</span>
                            </TableHead>
                          )}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {rows.length === 0 ? (
                          <TableRow>
                            <TableCell colSpan={renderAsManager ? 4 : 3} className="p-0">
                              <EmptyState
                                icon={<UsersIcon className="size-5" />}
                                title="Chưa có ai"
                                description={emptyText}
                              />
                            </TableCell>
                          </TableRow>
                        ) : (
                          rows.map(renderRow)
                        )}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              );

              return (
                <div className="flex flex-col gap-6 max-w-screen-2xl">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <UsersIcon className="size-4 text-muted-foreground" />
                      <h1 className="font-semibold">Thành viên khóa học</h1>
                    </div>
                    {renderAsManager && (
                      <AddCourseMemberDialog courseId={course.id} token={token} />
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground -mt-4">
                    Danh sách người dùng đang tham gia khóa học &ldquo;{course.title}&rdquo;.
                  </p>

                  {renderGroup(
                    managers,
                    "Quản lý",
                    "Người có thể quản lý nội dung và vừa có thể học như học viên.",
                    "Chưa có quản lý nào trong trang này.",
                    "members-group-managers",
                    "bg-blue-500",
                  )}

                  {renderGroup(
                    learners,
                    "Thành viên",
                    "Học viên — chỉ tham gia học trong khóa học này.",
                    "Chưa có học viên nào trong trang này.",
                    "members-group-learners",
                    "bg-emerald-500",
                  )}

                  <Pagination
                    page={membersPage}
                    hasNext={membersHasNext}
                    buildHref={(p) =>
                      `/dashboard/organizations/${slug}/courses/${courseId}?tab=members&page=${p}${learnMode ? "&mode=learn" : ""}`
                    }
                  />
                </div>
              );
            })()}

            {/* ── Tab: Duyệt yêu cầu ── */}
            {activeTab === "join-requests" && (
              <div className="flex flex-col gap-4 max-w-screen-2xl">
                {renderAsManager ? (
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
                {renderAsManager ? (
                  <>
                    <h1 className="font-semibold">Kết quả học viên</h1>
                    <div className="overflow-x-auto">
                      <CourseResults courseId={course.id} token={token} initialSub={resultsSub} />
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
