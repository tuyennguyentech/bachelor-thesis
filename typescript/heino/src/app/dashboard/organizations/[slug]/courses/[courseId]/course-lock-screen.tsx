"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { LockIcon, ClockIcon, XCircleIcon, ChevronLeftIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { createJoinRequestAction } from "@/app/actions/course-members";
import {
  CourseRole,
  JoinRequestStatus,
  type CourseJoinRequest,
} from "buf/gen/richter/v1/course_members_pb";

interface CourseLockScreenProps {
  slug: string;
  courseId: string;
  courseTitle: string;
  courseDescription?: string;
  joinRequest: CourseJoinRequest | null;
  /**
   * When true the requester is an org-level teacher who is allowed to ask for
   * the manager (TEACHER) role, so we expose a role selector. A plain learner
   * can only request the STUDENT role.
   */
  canRequestManager: boolean;
}

const ROLE_LABEL: Record<number, string> = {
  [CourseRole.STUDENT]: "Vào học (Thành viên)",
  [CourseRole.TEACHER]: "Làm quản lý (Quản lý)",
};

export function CourseLockScreen({
  slug,
  courseId,
  courseTitle,
  courseDescription,
  joinRequest,
  canRequestManager,
}: CourseLockScreenProps) {
  const [isPending, startTransition] = useTransition();
  const [requestedRole, setRequestedRole] = useState(String(CourseRole.STUDENT));
  const [error, setError] = useState<string | null>(null);

  const handleRequestJoin = () => {
    const role = (parseInt(requestedRole, 10) as CourseRole) || CourseRole.STUDENT;
    setError(null);
    startTransition(async () => {
      const res = await createJoinRequestAction(slug, courseId, role);
      if (res && "error" in res && res.error) {
        setError(res.error);
      }
    });
  };

  const status = joinRequest?.status ?? JoinRequestStatus.UNSPECIFIED;
  const canSubmit = status === JoinRequestStatus.UNSPECIFIED || status === JoinRequestStatus.REJECTED;

  return (
    <div className="flex min-h-[calc(100vh-3.5rem)] items-center justify-center p-4 bg-muted/30">
      <Card className="w-full max-w-lg border-border/80 shadow-xl rounded-2xl overflow-hidden backdrop-blur-sm bg-card/90">
        <div className="h-2 bg-primary/80" />
        <CardHeader className="text-center pt-8 pb-6">
          <div className="mx-auto size-16 rounded-full bg-primary/10 flex items-center justify-center mb-4 text-primary">
            <LockIcon className="size-8" />
          </div>
          <CardTitle className="text-2xl font-bold tracking-tight text-foreground/95">
            Khóa học đang bị khóa
          </CardTitle>
          <CardDescription className="text-sm text-muted-foreground mt-1 max-w-sm mx-auto">
            Bạn chưa đăng ký tham gia hoặc chưa được phê duyệt vào khóa học này.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-6 px-6 sm:px-8">
          <div className="rounded-xl border bg-muted/40 p-4 space-y-2">
            <h3 className="font-semibold text-sm text-foreground/90">{courseTitle}</h3>
            {courseDescription ? (
              <p className="text-xs text-muted-foreground leading-relaxed">{courseDescription}</p>
            ) : (
              <p className="text-xs text-muted-foreground/60 italic">Không có mô tả khóa học.</p>
            )}
          </div>

          {/* Status Alert UI */}
          {status === JoinRequestStatus.PENDING && (
            <div className="flex items-start gap-3 rounded-xl border border-amber-500/25 bg-amber-500/5 p-4 text-amber-600 dark:text-amber-500">
              <ClockIcon className="size-5 shrink-0 mt-0.5 animate-spin-slow" />
              <div className="space-y-1">
                <p className="text-sm font-semibold">Đang chờ phê duyệt</p>
                <p className="text-xs text-muted-foreground/80 leading-relaxed">
                  Yêu cầu của bạn đã được gửi
                  {joinRequest && joinRequest.requestedRole === CourseRole.TEACHER
                    ? " với vai trò quản lý"
                    : ""}
                  . Vui lòng chờ giảng viên hoặc quản trị viên phê duyệt.
                </p>
              </div>
            </div>
          )}

          {status === JoinRequestStatus.REJECTED && (
            <div className="flex items-start gap-3 rounded-xl border border-destructive/25 bg-destructive/5 p-4 text-destructive">
              <XCircleIcon className="size-5 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="text-sm font-semibold">Yêu cầu bị từ chối</p>
                <p className="text-xs text-muted-foreground/80 leading-relaxed">
                  Yêu cầu tham gia khóa học này của bạn đã bị từ chối. Bạn có thể gửi lại yêu cầu nếu cần.
                </p>
              </div>
            </div>
          )}

          {/* Role selector — only an org teacher may choose to request the manager role. */}
          {canSubmit && canRequestManager && (
            <div className="space-y-1.5">
              <Label htmlFor="request-role">Bạn muốn tham gia với vai trò</Label>
              <Select value={requestedRole} onValueChange={setRequestedRole}>
                <SelectTrigger id="request-role" data-testid="request-role-select">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={String(CourseRole.STUDENT)}>
                    {ROLE_LABEL[CourseRole.STUDENT]}
                  </SelectItem>
                  <SelectItem value={String(CourseRole.TEACHER)}>
                    {ROLE_LABEL[CourseRole.TEACHER]}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
        </CardContent>

        <CardFooter className="flex flex-col gap-3 px-6 sm:px-8 pb-8 pt-4">
          {error && (
            <p className="w-full text-center text-xs text-destructive" role="alert" data-testid="request-join-error">
              {error}
            </p>
          )}
          {canSubmit ? (
            <Button
              className="w-full h-11 text-sm font-medium rounded-xl shadow-md transition-all active:scale-[0.98]"
              onClick={handleRequestJoin}
              disabled={isPending}
              data-testid="request-join-submit"
            >
              {isPending
                ? "Đang gửi yêu cầu..."
                : status === JoinRequestStatus.REJECTED
                  ? "Gửi lại yêu cầu tham gia"
                  : "Yêu cầu tham gia khóa học"}
            </Button>
          ) : (
            <Button className="w-full h-11 text-sm font-medium rounded-xl" disabled variant="secondary">
              Đã gửi yêu cầu tham gia
            </Button>
          )}

          <Button variant="ghost" size="sm" asChild className="text-xs gap-1.5 h-9 font-medium text-muted-foreground hover:text-foreground">
            <Link href={`/dashboard/organizations/${slug}/courses`}>
              <ChevronLeftIcon className="size-4" />
              Quay lại danh sách khóa học
            </Link>
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
