export const RECENT_ACCESS_COOKIE = "dyadia_recent_access";
export const RECENT_ACCESS_LIMIT = 20;

export type RecentAccessType = "organization" | "course" | "lesson";

export interface RecentAccessEntry {
  id: string;
  type: RecentAccessType;
  orgSlug: string;
  title: string;
  href: string;
  accessedAt: number;
  subtitle?: string;
}

function isRecentAccessType(value: unknown): value is RecentAccessType {
  return value === "organization" || value === "course" || value === "lesson";
}

function cleanString(value: unknown, maxLength: number) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

function normalizeEntry(value: unknown): RecentAccessEntry | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const type = record.type;
  if (!isRecentAccessType(type)) return null;

  const id = cleanString(record.id, 160);
  const orgSlug = cleanString(record.orgSlug, 120);
  const title = cleanString(record.title, 160);
  const href = cleanString(record.href, 320);
  const subtitle = cleanString(record.subtitle, 220);
  const accessedAt = Number(record.accessedAt);

  if (!id || !orgSlug || !title || !href.startsWith("/dashboard/organizations/")) {
    return null;
  }

  return {
    id,
    type,
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
  return encodeURIComponent(JSON.stringify(entries.slice(0, RECENT_ACCESS_LIMIT)));
}

export function upsertRecentAccess(
  entries: RecentAccessEntry[],
  entry: RecentAccessEntry,
): RecentAccessEntry[] {
  const next = [
    { ...entry, accessedAt: Date.now() },
    ...entries.filter((item) => item.id !== entry.id),
  ];

  return next
    .map(normalizeEntry)
    .filter((item): item is RecentAccessEntry => Boolean(item))
    .sort((a, b) => b.accessedAt - a.accessedAt)
    .slice(0, RECENT_ACCESS_LIMIT);
}
