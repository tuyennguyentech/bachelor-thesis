"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { GraduationCapIcon, SettingsIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { enrollSelfAction } from "@/app/actions/course-members";
import { CourseRole } from "buf/gen/richter/v1/course_members_pb";

interface CourseModeToggleProps {
  slug: string;
  courseId: string;
  /** Current course-level mode signal. */
  mode: "manage" | "learn";
  /**
   * Whether the current user already has an explicit course_members row. When
   * false, the manager has bypass access only and the Learn CTA must first call
   * enrollSelf (first entry) before switching into learn mode.
   */
  isMember: boolean;
}

/**
 * Manager-only "Vào học | Quản lý" toggle. Threading happens via `?mode=learn`
 * on the course URL — `mode=manage` (or absent) renders the authoring
 * workspace, `mode=learn` renders the read-only student flow with REAL
 * persisted attempts.
 */
export function CourseModeToggle({ slug, courseId, mode, isMember }: CourseModeToggleProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const learnHref = `/dashboard/organizations/${slug}/courses/${courseId}?mode=learn`;
  const manageHref = `/dashboard/organizations/${slug}/courses/${courseId}`;

  // First entry (no membership row yet): materialise the manager membership
  // before navigating into learn mode. Re-entry just navigates. Only navigate
  // once the enrol succeeds — otherwise we'd land in learn mode without an
  // actual membership row and silently swallow the failure.
  const handleEnterLearn = () => {
    setError(null);
    startTransition(async () => {
      const res = await enrollSelfAction(slug, courseId, CourseRole.TEACHER);
      if (res && "error" in res && res.error) {
        setError(res.error);
        return;
      }
      router.push(learnHref);
      router.refresh();
    });
  };

  return (
    <div className="inline-flex flex-col items-end gap-1">
    <div className="inline-flex items-center rounded-lg border bg-muted/40 p-0.5" role="group" aria-label="Chế độ khóa học">
      {mode === "learn" ? (
        // Already in learn mode → Manage is a plain link, Learn is the active pill.
        <>
          <span
            data-testid="learn-toggle"
            data-active="true"
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium",
              "bg-background text-foreground shadow-sm",
            )}
          >
            <GraduationCapIcon className="size-4" />
            Vào học
          </span>
          <Button
            asChild
            variant="ghost"
            size="sm"
            data-testid="manage-toggle"
            className="gap-1.5 text-muted-foreground hover:text-foreground"
          >
            <Link href={manageHref}>
              <SettingsIcon className="size-4" />
              Quản lý
            </Link>
          </Button>
        </>
      ) : (
        // In manage mode → Learn triggers (maybe enrol then) navigate; Manage active.
        <>
          {isMember ? (
            <Button
              asChild
              variant="ghost"
              size="sm"
              data-testid="learn-toggle"
              className="gap-1.5 text-muted-foreground hover:text-foreground"
            >
              <Link href={learnHref}>
                <GraduationCapIcon className="size-4" />
                Vào lại học
              </Link>
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              data-testid="learn-toggle"
              data-first-entry="true"
              onClick={handleEnterLearn}
              disabled={isPending}
              className="gap-1.5 text-muted-foreground hover:text-foreground"
            >
              <GraduationCapIcon className="size-4" />
              {isPending ? "Đang tham gia…" : "Tham gia học"}
            </Button>
          )}
          <span
            data-testid="manage-toggle"
            data-active="true"
            className="inline-flex items-center gap-1.5 rounded-md bg-background px-3 py-1.5 text-sm font-medium text-foreground shadow-sm"
          >
            <SettingsIcon className="size-4" />
            Quản lý
          </span>
        </>
      )}
    </div>
      {error && (
        <p className="text-xs text-destructive" role="alert" data-testid="learn-toggle-error">
          {error}
        </p>
      )}
    </div>
  );
}
