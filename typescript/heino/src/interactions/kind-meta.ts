import { InteractionKind } from "buf/gen/richter/v1/interactions_pb";

/**
 * Single source of truth for interaction-kind display metadata (Vietnamese label,
 * badge classes, bar/dot colour). Keyed by the InteractionKind enum so callers
 * holding a proto value don't re-encode the palette (it had drifted across files).
 */
export interface KindMeta {
  label: string;
  /** Pill/badge background + text classes (light + dark). */
  badgeClass: string;
  /** Solid fill colour for bars/dots. */
  barColor: string;
}

const META: Partial<Record<InteractionKind, KindMeta>> = {
  [InteractionKind.SINGLE_CHOICE]: {
    label: "Trắc nghiệm",
    badgeClass: "bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-400",
    barColor: "bg-rose-500",
  },
  [InteractionKind.MULTIPLE_CHOICE]: {
    label: "Nhiều đáp án",
    badgeClass: "bg-purple-100 text-purple-700 dark:bg-purple-950/40 dark:text-purple-400",
    barColor: "bg-purple-500",
  },
  [InteractionKind.FILL_BLANK]: {
    label: "Điền từ",
    badgeClass: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400",
    barColor: "bg-emerald-500",
  },
  [InteractionKind.LISTENING]: {
    label: "Bài nghe",
    badgeClass: "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400",
    barColor: "bg-amber-500",
  },
  [InteractionKind.READING]: {
    label: "Bài đọc",
    badgeClass: "bg-sky-100 text-sky-700 dark:bg-sky-950/40 dark:text-sky-400",
    barColor: "bg-sky-500",
  },
  [InteractionKind.WRITING]: {
    label: "Viết",
    badgeClass: "bg-indigo-100 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-400",
    barColor: "bg-indigo-500",
  },
};

const FALLBACK: KindMeta = {
  label: "Khác",
  badgeClass: "bg-muted text-muted-foreground",
  barColor: "bg-muted-foreground",
};

export function kindMeta(kind: InteractionKind): KindMeta {
  return META[kind] ?? FALLBACK;
}
