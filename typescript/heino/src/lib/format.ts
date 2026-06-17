/**
 * Shared display formatters. Keep score/number formatting here so the lesson
 * result card and the teacher attempts table never drift apart.
 */

/** Format a score as a compact string, trimming trailing zeros (e.g. 3 → "3", 2.5 → "2.5"). */
export function formatScore(n: number): string {
  return Number(n.toFixed(2)).toString();
}

/**
 * Format seconds as m:ss (e.g. 90 → "1:30"). Truncates fractional seconds.
 * Returns "0:00" for non-finite input (video currentTime/duration can be NaN
 * before metadata loads).
 */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
