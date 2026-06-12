import fs from "fs";
import path from "path";
import { test as base, expect, type Page } from "@playwright/test";
import { createClient, type Client, type Interceptor } from "@connectrpc/connect";
import type { DescService } from "@bufbuild/protobuf";
import { createConnectTransport } from "@connectrpc/connect-node";
import { AuthService } from "buf/gen/richter/v1/auth_pb";
import {
  UserService,
  UserRole,
  UserStatus,
} from "buf/gen/richter/v1/users_pb";
import {
  OrganizationService,
} from "buf/gen/richter/v1/organizations_pb";
import {
  OrganizationMemberService,
  OrganizationRole,
  MemberStatus,
} from "buf/gen/richter/v1/organization_members_pb";
import {
  CourseMemberService,
  CourseRole,
} from "buf/gen/richter/v1/course_members_pb";
import {
  CourseService,
  CourseModuleService,
  LessonService,
} from "buf/gen/richter/v1/courses_pb";
import {
  InteractionService,
  InteractionKind,
  type CreateManualInteractionRequest,
} from "buf/gen/richter/v1/interactions_pb";
import {
  AIService,
  LessonTaskKind,
  LessonTaskStatus,
  type TranscriptChunk,
} from "buf/gen/richter/v1/ai_pb";
import { StorageService } from "buf/gen/richter/v1/storage_pb";

export const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "admin@dyadia.local";
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "changeme123";
export const USER_EMAIL = process.env.USER_EMAIL ?? "alice@dyadia.local";
export const USER_PASSWORD = process.env.USER_PASSWORD ?? "Password123!";
export const SEED_ORG_SLUG = process.env.TEST_ORG_SLUG ?? "dyadia-demo";
// carol is teacher in hust-cs; bob is student in hust-cs.
// NOTE: bob also has admin/teacher roles in other orgs, so he is NOT a "pure"
// student — the dashboard's student-progress section only renders for users
// with no manage role anywhere. Use PURE_STUDENT_EMAIL (eve, student-only and
// enrolled in the DSA course with an attempt) to exercise that feature.
export const TEACHER_EMAIL = "carol@dyadia.local";
export const STUDENT_EMAIL = "bob@dyadia.local";
export const PURE_STUDENT_EMAIL = "eve@dyadia.local";

const authTransports = new Map<string, ReturnType<typeof createConnectTransport>>();

function getAuthTransport(baseURL: string) {
  const rpcBaseUrl = process.env.RICHTER_BASE_URL ?? `${baseURL}/api/richter`;
  let transport = authTransports.get(rpcBaseUrl);
  if (!transport) {
    transport = createConnectTransport({ httpVersion: "1.1", baseUrl: rpcBaseUrl });
    authTransports.set(rpcBaseUrl, transport);
  }
  return transport;
}

export async function loginAs(page: Page, email: string, password: string, baseURL = "http://caddy") {
  const client = createClient(AuthService, getAuthTransport(baseURL));
  const res = await client.login({ email, password });
  const secure = baseURL.startsWith("https://");

  await page.context().addCookies([
    {
      name: "dyadia_access",
      value: res.accessToken,
      url: baseURL,
      httpOnly: true,
      sameSite: "Lax",
      secure,
    },
    {
      name: "dyadia_refresh",
      value: res.refreshToken,
      url: baseURL,
      httpOnly: true,
      sameSite: "Lax",
      secure,
    },
  ]);
}

/* eslint-disable react-hooks/rules-of-hooks --
 * `use` is Playwright's fixture-injection callback, not the React `use` hook.
 * ESLint's rules-of-hooks rule misidentifies it because of the name collision.
 */
export const test = base.extend<{
  adminPage: Page;
  userPage: Page;
  teacherPage: Page;
  studentPage: Page;
  pureStudentPage: Page;
}>({
  adminPage: async ({ page, baseURL }, use) => {
    await loginAs(page, ADMIN_EMAIL, ADMIN_PASSWORD, baseURL);
    await use(page);
  },
  userPage: async ({ page, baseURL }, use) => {
    await loginAs(page, USER_EMAIL, USER_PASSWORD, baseURL);
    await use(page);
  },
  teacherPage: async ({ page, baseURL }, use) => {
    await loginAs(page, TEACHER_EMAIL, USER_PASSWORD, baseURL);
    await use(page);
  },
  studentPage: async ({ page, baseURL }, use) => {
    await loginAs(page, STUDENT_EMAIL, USER_PASSWORD, baseURL);
    await use(page);
  },
  pureStudentPage: async ({ page, baseURL }, use) => {
    await loginAs(page, PURE_STUDENT_EMAIL, USER_PASSWORD, baseURL);
    await use(page);
  },
});
/* eslint-enable react-hooks/rules-of-hooks */

// ── Seeded data helpers ──────────────────────────────────────────────────────

export const SEED_HUST_CS_SLUG = "hust-cs";
export const SEED_DSA_COURSE_TITLE = "Cấu trúc dữ liệu và Giải thuật";
export const SEED_DSA_LESSON_BIG_O = "Bài 1: Big-O, Omega, Theta notation";
export const SEED_DSA_LESSON_RECURRENCE = "Bài 2: Phân tích đệ quy với Master Theorem";

async function isOnSeededLesson(page: Page, lessonTitle: string) {
  return page.url().includes("/lessons/") && (await page.getByRole("heading", { name: lessonTitle }).isVisible().catch(() => false));
}

/**
 * Navigate to a lesson inside the seeded DSA course (in hust-cs org) using ?q= search.
 * Returns the lesson URL — earlier "iterate through 30 pages" variants were flaky when
 * seed data shifted; the search query is canonical because course titles are unique.
 */
export async function goToSeededLesson(page: Page, lessonTitle: string): Promise<string> {
  if (await isOnSeededLesson(page, lessonTitle)) {
    return page.url();
  }

  const coursesUrl = `/dashboard/organizations/${SEED_HUST_CS_SLUG}/courses`;
  try {
    await page.goto(`${coursesUrl}?q=${encodeURIComponent(SEED_DSA_COURSE_TITLE)}`, { waitUntil: "domcontentloaded" });
  } catch (err) {
    if (!(await isOnSeededLesson(page, lessonTitle))) {
      throw err;
    }
    return page.url();
  }

  // Courses page redesigned to cards — find by card text then read the "Quản lý"/"Vào học" link href
  const courseCard = page.locator("[data-slot='card'], .group").filter({ hasText: SEED_DSA_COURSE_TITLE }).first();
  const courseHref = await courseCard.getByRole("link").last().getAttribute("href");
  if (!courseHref) throw new Error(`Seeded course "${SEED_DSA_COURSE_TITLE}" not found`);
  // Course workspace: lessons are in ?tab=lessons tab (not the default overview tab)
  await page.goto(`${courseHref}?tab=lessons`, { waitUntil: "domcontentloaded" });
  const lessonLink = page.getByRole("link").filter({ hasText: lessonTitle }).first();
  const lessonHref = await lessonLink.getAttribute("href");
  if (!lessonHref) throw new Error(`Lesson link not found for "${lessonTitle}"`);
  await page.goto(lessonHref, { waitUntil: "domcontentloaded" });
  return lessonHref;
}

// ── Isolation helpers ────────────────────────────────────────────────────────

const TEST_VIDEO_WITH_AUDIO = path.join(__dirname, "fixtures/edu-sample-en.mp4");

/**
 * Generates a collision-proof name: e.g. "My Base 1718000000000-abc123".
 * Use for course/module/lesson titles so parallel workers never clash.
 * When base is empty, returns just the timestamp-random suffix (no leading space),
 * so it is safe to use in email addresses: `uid("")@test.local`.
 */
export function uid(base: string): string {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return base ? `${base} ${suffix}` : suffix;
}

/** Resolve the richter RPC base URL from env or from Playwright's baseURL. */
export function rpcBaseUrl(baseURL?: string): string {
  return process.env.RICHTER_BASE_URL ?? `${baseURL ?? "http://caddy"}/api/richter`;
}

/**
 * Exchange email + password for an access token.
 * Uses a plain (unauthenticated) transport; result is the raw JWT string.
 */
export async function getToken(email: string, password: string, baseURL?: string): Promise<string> {
  const transport = createConnectTransport({ httpVersion: "1.1", baseUrl: rpcBaseUrl(baseURL) });
  const auth = createClient(AuthService, transport);
  const res = await auth.login({ email, password });
  return res.accessToken;
}

/**
 * Exchange email + password for the user's UUID.
 */
export async function getUserId(email: string, password: string, baseURL?: string): Promise<string> {
  const transport = createConnectTransport({ httpVersion: "1.1", baseUrl: rpcBaseUrl(baseURL) });
  const auth = createClient(AuthService, transport);
  const res = await auth.login({ email, password });
  return res.user?.id ?? "";
}

/**
 * Build an authenticated Connect transport that injects a Bearer token on every request.
 */
export function createAuthedTransport(token: string, baseURL?: string) {
  const authInterceptor: Interceptor = (next) => async (req) => {
    req.header.set("Authorization", `Bearer ${token}`);
    return next(req);
  };
  return createConnectTransport({
    httpVersion: "1.1",
    baseUrl: rpcBaseUrl(baseURL),
    interceptors: [authInterceptor],
  });
}

/**
 * Generic factory: create an authenticated Connect client for any generated service.
 *
 * @example
 *   const courses = authedClient(CourseService, token, baseURL);
 *   const res = await courses.listCourses({ organizationId, limit: 20, offset: 0 });
 */
export function authedClient<T extends DescService>(
  Service: T,
  token: string,
  baseURL?: string,
): Client<T> {
  return createClient(Service, createAuthedTransport(token, baseURL));
}

/**
 * Return `{ token, userId }` for carol (the seeded teacher in hust-cs).
 */
export async function getTeacherAuth(baseURL?: string): Promise<{ token: string; userId: string }> {
  const transport = createConnectTransport({ httpVersion: "1.1", baseUrl: rpcBaseUrl(baseURL) });
  const auth = createClient(AuthService, transport);
  const res = await auth.login({ email: TEACHER_EMAIL, password: USER_PASSWORD });
  return { token: res.accessToken, userId: res.user?.id ?? "" };
}

/**
 * Return `{ token, userId }` for the seeded admin account.
 */
export async function getAdminAuth(baseURL?: string): Promise<{ token: string; userId: string }> {
  const transport = createConnectTransport({ httpVersion: "1.1", baseUrl: rpcBaseUrl(baseURL) });
  const auth = createClient(AuthService, transport);
  const res = await auth.login({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  return { token: res.accessToken, userId: res.user?.id ?? "" };
}

/**
 * Create a new user via admin-only CreateUserWithRoleAndStatus RPC.
 * Returns the new user's UUID.
 *
 * @param adminToken  - Access token for a user with admin role.
 * @param opts.email  - Must be unique.
 * @param opts.password - Defaults to USER_PASSWORD.
 * @param opts.firstName - Defaults to "Test".
 * @param opts.lastName  - Defaults to "User".
 * @param opts.role   - Defaults to UserRole.NORMAL.
 * @param opts.status - Defaults to UserStatus.ACTIVE.
 */
export async function createUser(
  adminToken: string,
  opts: {
    email: string;
    password?: string;
    firstName?: string;
    lastName?: string;
    role?: UserRole;
    status?: UserStatus;
  },
  baseURL?: string,
): Promise<string> {
  const client = createClient(UserService, createAuthedTransport(adminToken, baseURL));
  const res = await client.createUserWithRoleAndStatus({
    email: opts.email,
    password: opts.password ?? USER_PASSWORD,
    firstName: opts.firstName ?? "Test",
    lastName: opts.lastName ?? "User",
    role: opts.role ?? UserRole.NORMAL,
    status: opts.status ?? UserStatus.ACTIVE,
  });
  const userId = res.user?.id;
  if (!userId) throw new Error(`createUser: no user id returned for ${opts.email}`);
  return userId;
}

/**
 * Resolve an organization UUID from its slug.
 */
export async function getOrgId(token: string, slug: string, baseURL?: string): Promise<string> {
  const client = createClient(OrganizationService, createAuthedTransport(token, baseURL));
  const res = await client.getOrganizationBySlug({ slug });
  const orgId = res.organization?.id;
  if (!orgId) throw new Error(`getOrgId: no org found for slug "${slug}"`);
  return orgId;
}

/**
 * Add a user to an organization with a given role.
 * Uses MEMBER_STATUS_ACTIVE by default.
 */
export async function addOrgMember(
  token: string,
  orgId: string,
  userId: string,
  role: OrganizationRole,
  baseURL?: string,
): Promise<void> {
  const client = createClient(OrganizationMemberService, createAuthedTransport(token, baseURL));
  await client.addOrganizationMember({
    organizationId: orgId,
    userId,
    role,
    status: MemberStatus.ACTIVE,
  });
}

/**
 * Submit a course join request as the given user (token = their access token).
 * Silently ignores AlreadyExists errors (request already pending).
 */
export async function submitJoinRequest(
  token: string,
  courseId: string,
  baseURL?: string,
): Promise<void> {
  const client = createClient(CourseMemberService, createAuthedTransport(token, baseURL));
  try {
    await client.createJoinRequest({ courseId });
  } catch (err: unknown) {
    // Ignore "already submitted" gracefully
    const code = (err as { code?: number })?.code;
    if (code !== 6 /* AlreadyExists */) throw err;
  }
}

/**
 * Add a user to a course with a given role.
 */
export async function addCourseMember(
  token: string,
  courseId: string,
  userId: string,
  role: CourseRole,
  baseURL?: string,
): Promise<void> {
  const client = createClient(CourseMemberService, createAuthedTransport(token, baseURL));
  await client.addCourseMember({ courseId, userId, role });
}

/**
 * Create a course in the given organization.
 * Returns the new course UUID.
 */
export async function createCourse(
  token: string,
  orgId: string,
  title: string,
  ownerId: string,
  baseURL?: string,
): Promise<string> {
  const client = createClient(CourseService, createAuthedTransport(token, baseURL));
  const res = await client.createCourse({ organizationId: orgId, ownerId, title, description: "" });
  const courseId = res.course?.id;
  if (!courseId) throw new Error(`createCourse: no course id returned for "${title}"`);
  return courseId;
}

/**
 * Create a module inside a course.
 * Returns the new module UUID.
 */
export async function createCourseModule(
  token: string,
  courseId: string,
  title: string,
  baseURL?: string,
): Promise<string> {
  const client = createClient(CourseModuleService, createAuthedTransport(token, baseURL));
  const res = await client.createCourseModule({ courseId, title, orderIndex: 0 });
  const moduleId = res.module?.id;
  if (!moduleId) throw new Error(`createCourseModule: no module id returned for "${title}"`);
  return moduleId;
}

/**
 * Create a lesson inside a module.
 * Returns the new lesson UUID.
 */
export async function createLesson(
  token: string,
  moduleId: string,
  title: string,
  baseURL?: string,
): Promise<string> {
  const client = createClient(LessonService, createAuthedTransport(token, baseURL));
  const res = await client.createLesson({ moduleId, title, description: "", orderIndex: 0 });
  const lessonId = res.lesson?.id;
  if (!lessonId) throw new Error(`createLesson: no lesson id returned for "${title}"`);
  return lessonId;
}

/**
 * Create a manual (non-AI) interaction on a lesson.
 * `kind` defaults to `InteractionKind.SINGLE_CHOICE`.
 * `startSeconds` defaults to 0.
 * Returns the new interaction UUID.
 *
 * @example
 *   const interactionId = await createInteraction(token, lessonId, {
 *     kind: InteractionKind.SINGLE_CHOICE,
 *     startSeconds: 5.0,
 *     prompt: "What is 2+2?",
 *     mcq: { options: [{ text: "4" }], correctAnswer: 0, correctAnswers: [], question: "" },
 *   });
 */
export async function createInteraction(
  token: string,
  lessonId: string,
  opts: Partial<Omit<CreateManualInteractionRequest, "lessonId">> & {
    kind?: InteractionKind;
    startSeconds?: number;
    prompt?: string;
  },
  baseURL?: string,
): Promise<string> {
  const client = createClient(InteractionService, createAuthedTransport(token, baseURL));
  // Default to a minimal single-choice MCQ if no config is provided, so the
  // server never sees an empty config (it returns "unsupported interaction config type").
  // Plain init-shape object (not the branded message type) — the connect client
  // accepts MessageInitShape, where McqOption is just { text }.
  const defaultMcqConfig = {
    case: "mcq" as const,
    value: { options: [{ text: "Đáp án A" }, { text: "Đáp án B" }], correctAnswer: 0, correctAnswers: [], question: "" },
  };
  const res = await client.createManualInteraction({
    lessonId,
    prompt: opts.prompt ?? "Test question",
    explanation: opts.explanation ?? "",
    startSeconds: opts.startSeconds ?? 0,
    chunkId: opts.chunkId ?? "",
    config: opts.config ?? defaultMcqConfig,
  });
  const interactionId = res.interaction?.id;
  if (!interactionId) throw new Error("createInteraction: no interaction id returned");
  return interactionId;
}

/**
 * Build the frontend lesson URL for a given org, course, and lesson.
 */
export function lessonUrlFor(orgSlug: string, courseId: string, lessonId: string): string {
  return `/dashboard/organizations/${orgSlug}/courses/${courseId}/lessons/${lessonId}`;
}

/**
 * API-only helper: creates a FRESH unique teacher, then creates a fresh
 * course → module → lesson owned by that teacher in the hust-cs org,
 * uploads the light test video `tests/fixtures/edu-sample-en.mp4` via
 * the storage presigned-URL API (no Page/browser), then runs
 * EXTRACT_TRANSCRIPT + CHUNK_TRANSCRIPT through the AI RPC, polling
 * until at least `minChunks` chunks exist.
 *
 * Because each call provisions its own teacher, parallel workers never
 * share a single user's 3-active-task cap.
 *
 * Returns `{ courseId, moduleId, lessonId, lessonUrl, chunks, token, teacherEmail }`
 * once the pipeline completes. Callers may pass `minChunks` to require
 * more chunks before the function returns.
 *
 * This function is safe to call from `test.beforeAll(async () => { ... })`
 * because it requires NO Page fixture — it is entirely API-driven.
 */
export async function createAnalyzedLesson(
  baseURL?: string,
  minChunks = 1,
): Promise<{
  courseId: string;
  moduleId: string;
  lessonId: string;
  lessonUrl: string;
  chunks: TranscriptChunk[];
  token: string;
  teacherEmail: string;
}> {
  const { token: adminToken } = await getAdminAuth(baseURL);

  // 1. Create a fresh unique teacher for this call so the 3-task cap
  //    is never shared across parallel workers.
  const teacherEmail = `teacher-${uid("")}@test.local`;
  const freshTeacherId = await createUser(
    adminToken,
    { email: teacherEmail, firstName: "Fresh", lastName: "Teacher", role: UserRole.NORMAL },
    baseURL,
  );

  // 2. Add the fresh teacher to hust-cs as TEACHER.
  const orgId = await getOrgId(adminToken, SEED_HUST_CS_SLUG, baseURL);
  await addOrgMember(adminToken, orgId, freshTeacherId, OrganizationRole.TEACHER, baseURL);

  // 3. Authenticate as the fresh teacher.
  const token = await getToken(teacherEmail, USER_PASSWORD, baseURL);
  const transport = createAuthedTransport(token, baseURL);

  // 4. Create fresh course → module → lesson with unique uid titles.
  const courseClient = createClient(CourseService, transport);
  const courseRes = await courseClient.createCourse({
    organizationId: orgId,
    ownerId: freshTeacherId,
    title: uid("Khóa học Phân tích"),
    description: "",
  });
  const courseId = courseRes.course?.id;
  if (!courseId) throw new Error("createAnalyzedLesson: createCourse returned no id");

  // Add the seeded teacher (carol, used by teacherPage fixture) to the fresh course
  // so that Playwright tests using teacherPage can access the lesson page.
  // GetLessonById requires RequireCourseMemberByLesson, so carol must be a course member.
  // Only sys-admin, org-admin/owner, or an existing course teacher can add course members —
  // use the admin token here.
  const carolId = await getUserId(TEACHER_EMAIL, USER_PASSWORD, baseURL);
  await addCourseMember(adminToken, courseId, carolId, CourseRole.TEACHER, baseURL);

  const moduleClient = createClient(CourseModuleService, transport);
  const moduleRes = await moduleClient.createCourseModule({
    courseId,
    title: uid("Chương Phân tích"),
    orderIndex: 0,
  });
  const moduleId = moduleRes.module?.id;
  if (!moduleId) throw new Error("createAnalyzedLesson: createCourseModule returned no id");

  const lessonClient = createClient(LessonService, transport);
  const lessonRes = await lessonClient.createLesson({
    moduleId,
    title: uid("Bài Phân tích"),
    description: "",
    orderIndex: 0,
  });
  const lessonId = lessonRes.lesson?.id;
  if (!lessonId) throw new Error("createAnalyzedLesson: createLesson returned no id");

  const lessonUrl = lessonUrlFor(SEED_HUST_CS_SLUG, courseId, lessonId);

  // 5. Upload the video via presigned URL (no browser/Page needed).
  // The server enforces that the storage key is under the lesson video path:
  //   lessons/{lessonId}/video   OR
  //   lessons/{lessonId}/video.{ext}  OR
  //   lessons/{lessonId}/video/{filename}
  const videoKey = `lessons/${lessonId}/video.mp4`;
  const storageClient = createClient(StorageService, transport);
  const uploadRes = await storageClient.getUploadUrl({
    key: videoKey,
    contentType: "video/mp4",
    expiresInSeconds: 3600,
  });
  const videoBytes = fs.readFileSync(TEST_VIDEO_WITH_AUDIO);
  const uploadResp = await fetch(uploadRes.uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": "video/mp4" },
    body: videoBytes,
  });
  if (!uploadResp.ok) {
    throw new Error(`createAnalyzedLesson: video upload failed (${uploadResp.status})`);
  }

  // 6. Register the video storage key on the lesson (edu-sample-en.mp4 is ~6.3s).
  await lessonClient.updateLessonVideo({
    id: lessonId,
    videoStorageKey: videoKey,
    durationSeconds: 7,
  });

  // 7. Run EXTRACT_TRANSCRIPT via API and poll until terminal state.
  const aiClient = createClient(AIService, transport);
  await aiClient.startLessonTask({ lessonId, kind: LessonTaskKind.EXTRACT_TRANSCRIPT });
  const extractDeadline = Date.now() + 120_000;
  let extractDone = false;
  while (Date.now() < extractDeadline) {
    const tasks = await aiClient.listLessonTasks({ lessonId, activeOnly: false, limit: 20, offset: 0 });
    const extract = tasks.tasks.find((t) => t.kind === LessonTaskKind.EXTRACT_TRANSCRIPT);
    if (extract?.status === LessonTaskStatus.SUCCEEDED) { extractDone = true; break; }
    if (extract?.status === LessonTaskStatus.FAILED) throw new Error("createAnalyzedLesson: EXTRACT_TRANSCRIPT failed");
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (!extractDone) throw new Error("createAnalyzedLesson: EXTRACT_TRANSCRIPT timed out");

  // 8. Run CHUNK_TRANSCRIPT via API and poll until minChunks chunks exist.
  await aiClient.startLessonTask({ lessonId, kind: LessonTaskKind.CHUNK_TRANSCRIPT });
  const chunkDeadline = Date.now() + 120_000;
  while (Date.now() < chunkDeadline) {
    const analysis = await aiClient.getLessonAnalysis({ lessonId });
    if (analysis.chunks.length >= minChunks) {
      return { courseId, moduleId, lessonId, lessonUrl, chunks: analysis.chunks, token, teacherEmail };
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("createAnalyzedLesson: CHUNK_TRANSCRIPT timed out");
}

export { expect };
export type { Page };
// Re-export enum types so callers only need to import from fixtures.
export { UserRole, UserStatus, OrganizationRole, MemberStatus, CourseRole, InteractionKind };
