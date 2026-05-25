"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import {
  RECENT_ACCESS_COOKIE,
  parseRecentAccessCookie,
  serializeRecentAccess,
  upsertRecentAccess,
  type RecentAccessEntry,
} from "@/lib/recent-access";

interface RecentAccessRecorderProps {
  entry: Omit<RecentAccessEntry, "accessedAt">;
  exactPath?: boolean;
}

function readCookie(name: string) {
  return document.cookie
    .split("; ")
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

export function RecentAccessRecorder({ entry, exactPath = false }: RecentAccessRecorderProps) {
  const pathname = usePathname();
  const { id, type, orgSlug, title, subtitle, href } = entry;

  useEffect(() => {
    if (exactPath && pathname !== href) return;

    const entries = parseRecentAccessCookie(readCookie(RECENT_ACCESS_COOKIE));
    const nextEntries = upsertRecentAccess(entries, {
      id,
      type,
      orgSlug,
      title,
      href,
      accessedAt: Date.now(),
      ...(subtitle ? { subtitle } : {}),
    });
    document.cookie = [
      `${RECENT_ACCESS_COOKIE}=${serializeRecentAccess(nextEntries)}`,
      "Path=/",
      "Max-Age=7776000",
      "SameSite=Lax",
    ].join("; ");
  }, [exactPath, href, id, orgSlug, pathname, subtitle, title, type]);

  return null;
}
