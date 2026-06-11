"use client";

import { useTransition, useState } from "react";
import { CheckIcon, XIcon, UserCheckIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/ui/empty-state";
import { reviewJoinRequestAction } from "@/app/actions/course-members";
import type { CourseJoinRequest } from "buf/gen/richter/v1/course_members_pb";

interface JoinRequestsTabProps {
  slug: string;
  courseId: string;
  requests: CourseJoinRequest[];
}

export function JoinRequestsTab({ slug, courseId, requests }: JoinRequestsTabProps) {
  const [isPending, startTransition] = useTransition();
  const [processingUser, setProcessingUser] = useState<string | null>(null);

  const handleReview = (userId: string, approve: boolean) => {
    setProcessingUser(userId);
    startTransition(async () => {
      try {
        await reviewJoinRequestAction(slug, courseId, userId, approve);
      } finally {
        setProcessingUser(null);
      }
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <UserCheckIcon className="size-4 text-muted-foreground" />
        <h1 className="font-semibold">Duyệt yêu cầu tham gia</h1>
      </div>
      <p className="text-sm text-muted-foreground -mt-2">
        Danh sách người dùng đang gửi yêu cầu tham gia khóa học này. phê duyệt sẽ tự động thêm họ vào lớp với vai trò học viên.
      </p>

      <div className="rounded-md border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Người yêu cầu</TableHead>
              <TableHead>Ngày yêu cầu</TableHead>
              <TableHead className="w-44 text-right">Thao tác</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {requests.length === 0 ? (
              <TableRow>
                <TableCell colSpan={3} className="p-0">
                  <EmptyState
                    icon={<UserCheckIcon className="size-5" />}
                    title="Không có yêu cầu nào"
                    description="Hiện tại chưa có yêu cầu nào cần duyệt tham gia khóa học này."
                  />
                </TableCell>
              </TableRow>
            ) : (
              requests.map((r) => {
                const displayName =
                  `${r.userFirstName} ${r.userLastName}`.trim() || r.userId;
                const loading = isPending && processingUser === r.userId;
                return (
                  <TableRow key={r.userId}>
                    <TableCell>
                      <div className="flex flex-col gap-0.5">
                        <span className="text-sm font-medium">{displayName}</span>
                        {r.userEmail && (
                          <span className="text-xs text-muted-foreground">{r.userEmail}</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {r.createdAt
                        ? new Date(Number(r.createdAt.seconds) * 1000).toLocaleDateString("vi-VN")
                        : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-8 text-xs gap-1 border-green-500/30 text-green-600 hover:bg-green-500/10 hover:text-green-600 dark:border-green-500/20 dark:text-green-500 dark:hover:bg-green-500/10"
                          onClick={() => handleReview(r.userId, true)}
                          disabled={isPending}
                        >
                          <CheckIcon className="size-3.5" />
                          {loading && processingUser === r.userId ? "Đang duyệt..." : "Duyệt"}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 text-xs gap-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                          onClick={() => handleReview(r.userId, false)}
                          disabled={isPending}
                        >
                          <XIcon className="size-3.5" />
                          Từ chối
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
