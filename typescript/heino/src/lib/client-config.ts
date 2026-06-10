// Client-side config for the lesson analysis / task poller. Each value
// is a small tunables knob that affects the FE polling cadence, retry
// behaviour, and "stuck" detection — all of which are deployment /
// environment specific.
//
// Convention: a duration field is read from NEXT_PUBLIC_<NAME>_<UNIT>
// at module load. 0 means "unlimited" (where applicable) or "disabled"
// (where the field gates a poll/timeout).
//
//   NEXT_PUBLIC_ANALYSIS_SYNCING_POLL_MS         — 5000
//   NEXT_PUBLIC_ANALYSIS_SYNCING_TIMEOUT_MS      — 900000
//   NEXT_PUBLIC_ANALYSIS_NOW_TICK_MS             — 1000
//   NEXT_PUBLIC_ANALYSIS_STALE_THRESHOLD_MS      — 180000
//   NEXT_PUBLIC_ANALYSIS_HEARTBEAT_TIMEOUT_MS    — 30000
//   NEXT_PUBLIC_ANALYSIS_HEARTBEAT_POLL_MS       — 5000
//   NEXT_PUBLIC_LESSON_TASKS_POLL_MS             — 2500
//   NEXT_PUBLIC_LESSON_TASKS_POLL_BACKOFF_MAX_MS — 30000
//   NEXT_PUBLIC_VIDEO_SAVE_INTERVAL_S            — 10
//   NEXT_PUBLIC_SEEK_CLAMP_INTERVAL_MS           — 250
//   NEXT_PUBLIC_UPLOAD_TIMEOUT_MS                — 10000
//   NEXT_PUBLIC_TAB_EXERCISES_RETRY_MS           — 1000
//   NEXT_PUBLIC_COPY_TOAST_MS                    — 2000

const envNumber = (key: string, fallback: number): number => {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
};

export const analysisConfig = {
  // Syncing polling cadence. 0 disables polling (UI stuck forever).
  syncingPollMs: envNumber("NEXT_PUBLIC_ANALYSIS_SYNCING_POLL_MS", 5000),
  // now() tick for the "x giây trước" labels.
  nowTickMs: envNumber("NEXT_PUBLIC_ANALYSIS_NOW_TICK_MS", 1000),
  // Stale threshold (ms). A task that has been QUEUED or RUNNING on the
  // BE for longer than this is presumed stuck; FE surfaces a "stuck"
  // hero card with a recovery button. 0 disables stale detection.
  staleThresholdMs: envNumber("NEXT_PUBLIC_ANALYSIS_STALE_THRESHOLD_MS", 180_000),
  // Heartbeat timeout (ms). The BE writes a fresh `UpdatedAt` on every
  // progress tick. If a RUNNING task's last update is older than this,
  // the worker is presumed unresponsive and FE flips to "stale".
  heartbeatTimeoutMs: envNumber("NEXT_PUBLIC_ANALYSIS_HEARTBEAT_TIMEOUT_MS", 30_000),
  // Stale check poll cadence (ms). How often the FE re-scans the
  // polled lesson task list to detect stale tasks.
  heartbeatPollMs: envNumber("NEXT_PUBLIC_ANALYSIS_HEARTBEAT_POLL_MS", 5_000),
} as const;

export const lessonTasksConfig = {
  baseIntervalMs: envNumber("NEXT_PUBLIC_LESSON_TASKS_POLL_MS", 2500),
  maxBackoffMs: envNumber("NEXT_PUBLIC_LESSON_TASKS_POLL_BACKOFF_MAX_MS", 30000),
} as const;

export const videoPlayerConfig = {
  saveIntervalS: envNumber("NEXT_PUBLIC_VIDEO_SAVE_INTERVAL_S", 10),
  seekClampIntervalMs: envNumber("NEXT_PUBLIC_SEEK_CLAMP_INTERVAL_MS", 250),
} as const;

export const uploadConfig = {
  uploadTimeoutMs: envNumber("NEXT_PUBLIC_UPLOAD_TIMEOUT_MS", 10000),
  tabExercisesRetryMs: envNumber("NEXT_PUBLIC_TAB_EXERCISES_RETRY_MS", 1000),
  copyToastMs: envNumber("NEXT_PUBLIC_COPY_TOAST_MS", 2000),
} as const;
