import type { Timestamp } from "@bufbuild/protobuf/wkt";

/** Convert a protobuf Timestamp to milliseconds since epoch. */
export function timestampToMs(ts: Pick<Timestamp, "seconds">): number {
  return Number(ts.seconds) * 1000;
}

/**
 * Format a protobuf Timestamp as a localised Vietnamese date string,
 * e.g. "01/06/2026".
 */
export function formatDate(ts: Pick<Timestamp, "seconds">): string {
  return new Date(timestampToMs(ts)).toLocaleDateString("vi-VN");
}
