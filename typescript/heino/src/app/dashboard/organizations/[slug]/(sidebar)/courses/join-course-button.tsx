"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { enrollSelfAction } from "@/app/actions/course-members";
import { CourseRole } from "buf/gen/richter/v1/course_members_pb";
import { ArrowRightIcon, GraduationCapIcon } from "lucide-react";

/**
 * "Tham gia" button for a course the viewer can MANAGE (org owner/admin or course
 * owner) but has not yet joined. Org owners/admins are not auto-enrolled in every
 * course — they self-enrol at will, with no approval. EnrollSelf materialises a
 * course_members row (default role TEACHER) for the bypass caller, after which the
 * card moves to "Khóa học của bạn" and exposes the "Vào học" + "Vào quản lý" CTAs.
 *
 * On success we do a FULL reload of the current list rather than a soft
 * `router.refresh()`. The in-place RSC refresh proved unreliable: because it
 * participates in the click's React transition, a refresh whose re-render does not
 * settle leaves the button stuck on "Đang tham gia…" indefinitely (the pending
 * state never clears). A hard reload re-renders the list from a fresh server
 * response, deterministically re-sectioning the freshly-joined card, and replaces
 * the page so the button can never hang.
 */
export function JoinCourseButton({
  slug,
  courseId,
}: {
  slug: string;
  courseId: string;
}) {
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleJoin() {
    setJoining(true);
    setError(null);
    const res = await enrollSelfAction(slug, courseId, CourseRole.TEACHER);
    if (res?.error) {
      setError(res.error);
      setJoining(false);
      return;
    }
    // Keep `joining` true: the reload replaces the page and unmounts this button,
    // so it stays "Đang tham gia…" right up until the fresh list renders.
    window.location.reload();
  }

  return (
    <div className="flex flex-col items-end gap-1">
      {error && <span className="text-[10px] text-destructive text-right">{error}</span>}
      <Button
        size="sm"
        className="gap-1.5 transition-all group-hover:translate-x-0.5"
        disabled={joining}
        data-testid="card-join"
        onClick={handleJoin}
      >
        <GraduationCapIcon className="size-3.5" />
        {joining ? "Đang tham gia…" : "Tham gia"}
        {!joining && <ArrowRightIcon className="size-3.5" />}
      </Button>
    </div>
  );
}
