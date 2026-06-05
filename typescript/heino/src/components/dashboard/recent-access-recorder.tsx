"use client";

import { useEffect, useLayoutEffect } from "react";
import { usePathname } from "next/navigation";
import {
  RECENT_ACCESS_COOKIE,
  defaultRecentAccessArea,
  parseRecentAccessCookie,
  serializeRecentAccess,
  upsertRecentAccess,
  type RecentAccessArea,
  type RecentAccessEntry,
  type RecentAccessType,
} from "@/lib/recent-access";

interface RecentAccessRecorderProps {
  entry: Omit<RecentAccessEntry, "accessedAt" | "area" | "type"> & {
    area?: RecentAccessArea;
    type: RecentAccessType;
  };
  exactPath?: boolean;
}

function readCookie(name: string) {
  return document.cookie
    .split("; ")
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export function RecentAccessRecorder({ entry, exactPath = false }: RecentAccessRecorderProps) {
  const pathname = usePathname();
  const { id, type, orgSlug, title, subtitle, href } = entry;
  const { userId } = entry;
  const area = entry.area ?? defaultRecentAccessArea(type);

  useIsomorphicLayoutEffect(() => {
    const currentPath = window.location.pathname;
    if (exactPath && currentPath !== href) return;

    const entries = parseRecentAccessCookie(readCookie(RECENT_ACCESS_COOKIE));
    const nextEntries = upsertRecentAccess(entries, {
      userId,
      id,
      type,
      area,
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
  }, [area, exactPath, href, id, orgSlug, pathname, subtitle, title, type, userId]);

  return null;
}
