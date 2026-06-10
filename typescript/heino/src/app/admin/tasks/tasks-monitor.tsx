"use client";

import { useCallback, useEffect, useState } from "react";
import { AIService, LessonTask, LessonTaskKind, LessonTaskStatus } from "buf/gen/richter/v1/ai_pb";
import { useRichterWebClient } from "@/lib/connect-webclient";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Activity,
  CheckCircle2,
  XCircle,
  Loader2,
  StopCircle,
  RefreshCw,
} from "lucide-react";
import { cn } from "@/lib/utils";

const LIMIT = 20;

export function TasksMonitor({ token }: { token: string }) {
  const aiClient = useRichterWebClient(AIService, token);
  const [tasks, setTasks] = useState<LessonTask[]>([]);
  const [activeOnly, setActiveOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [activeTotalCount, setActiveTotalCount] = useState(0);

  const fetchTasks = useCallback(async (showRefresher = false, active = true) => {
    if (showRefresher && active) setRefreshing(true);
    try {
      const res = await aiClient.listAllTasks({
        activeOnly,
        limit: LIMIT,
        offset: (page - 1) * LIMIT,
      });
      if (active) setTasks(res.tasks ?? []);

      // Fetch active tasks across the whole system (limit 100 is enough)
      const activeRes = await aiClient.listAllTasks({
        activeOnly: true,
        limit: 100,
        offset: 0,
      });
      if (active) setActiveTotalCount(activeRes.tasks?.length ?? 0);
    } catch (err) {
      console.error("Failed to fetch tasks:", err);
    } finally {
      if (active) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [aiClient, activeOnly, page]);

  useEffect(() => {
    let active = true;
    fetchTasks(false, active);
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") {
        fetchTasks(false, active);
      }
    }, 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [fetchTasks]);

  const handleCancelTask = async (taskId: string) => {
    if (!confirm("Bạn có chắc chắn muốn huỷ tác vụ này?")) return;
    setCancellingId(taskId);
    try {
      await aiClient.cancelLessonTask({ taskId });
      await fetchTasks();
    } catch (err) {
      alert("Huỷ tác vụ thất bại!");
      console.error(err);
    } finally {
      setCancellingId(null);
    }
  };

  const activeCount = tasks.filter(
    (t) =>
      t.status === LessonTaskStatus.QUEUED ||
      t.status === LessonTaskStatus.RUNNING
  ).length;

  const successCount = tasks.filter(
    (t) => t.status === LessonTaskStatus.SUCCEEDED
  ).length;

  const failedCount = tasks.filter(
    (t) =>
      t.status === LessonTaskStatus.FAILED ||
      t.status === LessonTaskStatus.CANCELED
  ).length;

  const renderStatus = (status: LessonTaskStatus) => {
    switch (status) {
      case LessonTaskStatus.QUEUED:
        return (
          <Badge variant="outline" className="border-amber-500 text-amber-500 gap-1 bg-amber-500/5">
            <Loader2 className="size-3 animate-spin" />
            Đang chờ
          </Badge>
        );
      case LessonTaskStatus.RUNNING:
        return (
          <Badge variant="outline" className="border-sky-500 text-sky-500 gap-1 bg-sky-500/5">
            <Loader2 className="size-3 animate-spin" />
            Đang chạy
          </Badge>
        );
      case LessonTaskStatus.SUCCEEDED:
        return (
          <Badge variant="outline" className="border-emerald-500 text-emerald-500 gap-1 bg-emerald-500/5">
            <CheckCircle2 className="size-3" />
            Thành công
          </Badge>
        );
      case LessonTaskStatus.FAILED:
        return (
          <Badge variant="outline" className="border-destructive text-destructive gap-1 bg-destructive/5">
            <XCircle className="size-3" />
            Lỗi
          </Badge>
        );
      case LessonTaskStatus.CANCELED:
        return (
          <Badge variant="outline" className="border-muted-foreground text-muted-foreground gap-1 bg-muted/5">
            <StopCircle className="size-3" />
            Đã huỷ
          </Badge>
        );
      default:
        return <Badge variant="secondary">Không xác định</Badge>;
    }
  };

  const renderKind = (kind: LessonTaskKind) => {
    switch (kind) {
      case LessonTaskKind.EXTRACT_TRANSCRIPT:
        return "Phiên âm video";
      case LessonTaskKind.CHUNK_TRANSCRIPT:
        return "Phân đoạn bài giảng";
      case LessonTaskKind.GENERATE_INTERACTIONS:
        return "Tạo câu hỏi tương tác";
      default:
        return "Tác vụ khác";
    }
  };

  const renderProgress = (task: LessonTask) => {
    const total = task.progressTotal;
    const current = task.progressCurrent;
    const isRunning = task.status === LessonTaskStatus.RUNNING;
    const hasProgress = total > 0;
    const pct = hasProgress ? Math.min(100, Math.max(0, Math.round((current / total) * 100))) : 0;

    return (
      <div className="flex flex-col gap-1 min-w-[200px] max-w-[350px]">
        {task.message && (
          <span className="text-xs text-foreground font-medium truncate max-w-[280px]">
            {task.message}
          </span>
        )}
        {task.errorMsg && task.status === LessonTaskStatus.FAILED && (
          <span className="text-xs text-destructive font-medium break-words max-w-[280px]" title={task.errorMsg}>
            Lỗi: {task.errorMsg}
          </span>
        )}
        {isRunning && (
          <div className="flex items-center gap-2">
            <div className="h-1.5 w-full rounded-full bg-secondary overflow-hidden">
              <div
                className={cn(
                  "h-full transition-all duration-300",
                  hasProgress ? "bg-primary" : "bg-sky-500 animate-pulse w-full"
                )}
                style={{ width: hasProgress ? `${pct}%` : "100%" }}
              />
            </div>
            {hasProgress && (
              <span className="text-[10px] text-muted-foreground font-mono">
                {current}/{total} ({pct}%)
              </span>
            )}
          </div>
        )}
      </div>
    );
  };

  const renderDuration = (task: LessonTask) => {
    if (!task.startedAt) return "—";
    const start = Number(task.startedAt.seconds) * 1000;
    const end = task.finishedAt ? Number(task.finishedAt.seconds) * 1000 : Date.now();
    const diff = Math.max(0, end - start);
    const sec = Math.floor(diff / 1000);
    if (sec < 60) return `${sec} giây`;
    const min = Math.floor(sec / 60);
    const remSec = sec % 60;
    return `${min} phút ${remSec} giây`;
  };

  return (
    <div className="flex flex-col gap-6">
      {/* Dashboard Stats */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card className="bg-card border shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Đang hoạt động (Toàn hệ thống)</CardTitle>
            <Activity className="size-4 text-sky-500 animate-pulse" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-sky-500">{activeTotalCount}</div>
            <p className="text-xs text-muted-foreground">Tổng số tác vụ đang chạy hoặc chờ trong hàng đợi</p>
          </CardContent>
        </Card>

        <Card className="bg-card border shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Thành công (Trang này)</CardTitle>
            <CheckCircle2 className="size-4 text-emerald-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-emerald-500">{successCount}</div>
            <p className="text-xs text-muted-foreground">Số tác vụ thành công trên trang hiện tại</p>
          </CardContent>
        </Card>

        <Card className="bg-card border shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Thất bại / Đã huỷ (Trang này)</CardTitle>
            <XCircle className="size-4 text-destructive" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-destructive">{failedCount}</div>
            <p className="text-xs text-muted-foreground">Số tác vụ lỗi hoặc bị huỷ trên trang hiện tại</p>
          </CardContent>
        </Card>
      </div>

      {/* Header and Controls */}
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-xl font-bold">Danh sách tác vụ</h2>
          <p className="text-xs text-muted-foreground">Danh sách các tác vụ chạy AI hoặc phân tích bài học trên toàn hệ thống.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setActiveOnly((prev) => !prev);
              setPage(1);
            }}
            className={cn(activeOnly && "bg-sky-500/10 text-sky-500 border-sky-500/30 font-medium")}
          >
            {activeOnly ? "Hiển thị tất cả" : "Chỉ hiển thị đang chạy"}
          </Button>

          <Button
            variant="outline"
            size="sm"
            onClick={() => fetchTasks(true, true)}
            disabled={refreshing}
            className="gap-2"
          >
            <RefreshCw className={cn("size-3", refreshing && "animate-spin")} />
            Làm mới
          </Button>
        </div>
      </div>

      {/* Table Section */}
      <div className="rounded-md border bg-card">
        {loading ? (
          <div className="flex h-32 items-center justify-center gap-2 text-muted-foreground text-sm">
            <Loader2 className="size-4 animate-spin text-primary" />
            Đang tải dữ liệu tác vụ...
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[100px]">ID</TableHead>
                <TableHead className="w-[150px]">Loại tác vụ</TableHead>
                <TableHead className="w-[120px]">Trạng thái</TableHead>
                <TableHead>Tiến độ & Thông điệp</TableHead>
                <TableHead className="w-[120px]">Thời gian chạy</TableHead>
                <TableHead className="w-[180px]">Ngày tạo</TableHead>
                <TableHead className="w-[100px] text-right" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {tasks.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-8 text-muted-foreground text-sm">
                    Không tìm thấy tác vụ nào.
                  </TableCell>
                </TableRow>
              ) : (
                tasks.map((task) => (
                  <TableRow key={task.id}>
                    <TableCell className="font-mono text-[10px] text-muted-foreground">
                      <span title={task.id}>{task.id.slice(0, 8)}...</span>
                    </TableCell>
                    <TableCell className="font-medium text-sm">
                      {renderKind(task.kind)}
                    </TableCell>
                    <TableCell>{renderStatus(task.status)}</TableCell>
                    <TableCell>{renderProgress(task)}</TableCell>
                    <TableCell className="text-sm font-medium">
                      {renderDuration(task)}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {task.createdAt
                        ? new Date(Number(task.createdAt.seconds) * 1000).toLocaleTimeString("vi-VN", {
                            hour: "2-digit",
                            minute: "2-digit",
                          }) +
                          " " +
                          new Date(Number(task.createdAt.seconds) * 1000).toLocaleDateString("vi-VN")
                        : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      {(task.status === LessonTaskStatus.QUEUED ||
                        task.status === LessonTaskStatus.RUNNING) && (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={cancellingId === task.id}
                          onClick={() => handleCancelTask(task.id)}
                          className="h-8 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive gap-1"
                        >
                          {cancellingId === task.id ? (
                            <Loader2 className="size-3 animate-spin" />
                          ) : (
                            <StopCircle className="size-3" />
                          )}
                          Huỷ
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        )}
        {/* Pagination Controls */}
        {!loading && (
          <div className="flex items-center justify-end space-x-2 py-4 px-4 border-t">
            <div className="text-xs text-muted-foreground flex-1">
              Trang {page}
            </div>
            <div className="space-x-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
              >
                Trang trước
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => p + 1)}
                disabled={tasks.length < LIMIT}
              >
                Trang sau
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
