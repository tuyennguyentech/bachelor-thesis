export const RECENT_ACCESS_COOKIE = "dyadia_recent_access";
export const RECENT_ACCESS_LIMIT = 20;
const RECENT_ACCESS_COOKIE_MAX_BYTES = 3800;

export type RecentAccessArea = "dashboard" | "admin";

export type RecentAccessType =
  | "dashboard-organizations"
  | "dashboard-profile"
  | "organization"
  | "organization-courses"
  | "organization-members"
  | "course"
  | "lesson"
  | "admin-users"
  | "admin-user"
  | "admin-organizations"
  | "admin-organization"
  | "admin-organization-members"
  | "admin-organization-courses"
  | "admin-course"
  | "admin-module";

export interface RecentAccessEntry {
  userId: string;
  id: string;
  type: RecentAccessType;
  area: RecentAccessArea;
  orgSlug?: string;
  title: string;
  href: string;
  accessedAt: number;
  subtitle?: string;
}

function recentAccessKey(entry: Pick<RecentAccessEntry, "area" | "id" | "type">) {
  return `${entry.area}:${entry.type}:${entry.id}`;
}

function isRecentAccessType(value: unknown): value is RecentAccessType {
  return (
    value === "organization" ||
    value === "dashboard-organizations" ||
    value === "dashboard-profile" ||
    value === "organization-courses" ||
    value === "organization-members" ||
    value === "course" ||
    value === "lesson" ||
    value === "admin-users" ||
    value === "admin-user" ||
    value === "admin-organizations" ||
    value === "admin-organization" ||
    value === "admin-organization-members" ||
    value === "admin-organization-courses" ||
    value === "admin-course" ||
    value === "admin-module"
  );
}

function isAdminType(type: RecentAccessType) {
  return type.startsWith("admin-");
}

export function defaultRecentAccessArea(type: RecentAccessType): RecentAccessArea {
  return isAdminType(type) ? "admin" : "dashboard";
}

function cleanArea(value: unknown, type: RecentAccessType): RecentAccessArea {
  if (value === "admin" || value === "dashboard") return value;
  return defaultRecentAccessArea(type);
}

function isSafeRelativeHref(href: string) {
  return href.startsWith("/") && !href.startsWith("//");
}

function cleanString(value: unknown, maxLength: number) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

function normalizeEntry(value: unknown): RecentAccessEntry | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const type = record.type ?? record.t;
  if (!isRecentAccessType(type)) return null;

  const userId = cleanString(record.userId ?? record.u, 160);
  const id = cleanString(record.id ?? record.i, 160);
  const area = cleanArea(record.area ?? record.a, type);
  const orgSlug = cleanString(record.orgSlug ?? record.o, 120) || undefined;
  const title = cleanString(record.title ?? record.l, 160);
  const href = cleanString(record.href ?? record.h, 320);
  const subtitle = cleanString(record.subtitle ?? record.s, 220);
  const accessedAt = Number(record.accessedAt ?? record.at);

  if (!userId || !id || !title || !isSafeRelativeHref(href)) {
    return null;
  }

  if (area === "admin") {
    if (!href.startsWith("/admin")) return null;
  } else if (!href.startsWith("/dashboard")) {
    return null;
  } else if (orgSlug && !href.startsWith(`/dashboard/organizations/${orgSlug}`)) {
    return null;
  }

  return {
    userId,
    id,
    type,
    area,
    orgSlug,
    title,
    href,
    accessedAt: Number.isFinite(accessedAt) ? accessedAt : 0,
    ...(subtitle ? { subtitle } : {}),
  };
}

export function parseRecentAccessCookie(value: string | undefined): RecentAccessEntry[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(decodeURIComponent(value));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizeEntry)
      .filter((entry): entry is RecentAccessEntry => Boolean(entry))
      .sort((a, b) => b.accessedAt - a.accessedAt)
      .slice(0, RECENT_ACCESS_LIMIT);
  } catch {
    return [];
  }
}

export function serializeRecentAccess(entries: RecentAccessEntry[]) {
  const compactEntries = entries.slice(0, RECENT_ACCESS_LIMIT).map((entry) => ({
    i: entry.id,
    u: entry.userId,
    t: entry.type,
    a: entry.area,
    ...(entry.orgSlug ? { o: entry.orgSlug } : {}),
    l: entry.title,
    h: entry.href,
    at: entry.accessedAt,
    ...(entry.subtitle ? { s: entry.subtitle } : {}),
  }));

  let count = compactEntries.length;
  while (count > 0) {
    const encoded = encodeURIComponent(JSON.stringify(compactEntries.slice(0, count)));
    if (encoded.length <= RECENT_ACCESS_COOKIE_MAX_BYTES) return encoded;
    count--;
  }
  return encodeURIComponent("[]");
}

export function upsertRecentAccess(
  entries: RecentAccessEntry[],
  entry: RecentAccessEntry,
): RecentAccessEntry[] {
  const key = recentAccessKey(entry);
  const next = [
    { ...entry, accessedAt: Date.now() },
    ...entries.filter((item) => recentAccessKey(item) !== key),
  ];

  return next
    .map(normalizeEntry)
    .filter((item): item is RecentAccessEntry => Boolean(item))
    .sort((a, b) => b.accessedAt - a.accessedAt)
    .slice(0, RECENT_ACCESS_LIMIT);
}
