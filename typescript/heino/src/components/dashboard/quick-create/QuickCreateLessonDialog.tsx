"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import {
  ZapIcon,
  UploadCloudIcon,
  FileVideo2Icon,
  Loader2Icon,
  CheckCircleIcon,
  AlertCircleIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  SlidersHorizontalIcon,
  XCircleIcon,
  ArrowRightIcon,
  RefreshCcwIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useRichterWebClient } from "@/lib/connect-webclient";
import { StorageService } from "buf/gen/richter/v1/storage_pb";
import {
  LessonService,
  type CourseModule,
} from "buf/gen/richter/v1/courses_pb";
import {
  AIService,
  LessonTaskKind,
  LessonTaskStatus,
  type LessonTask,
} from "buf/gen/richter/v1/ai_pb";
import { InteractionKind } from "buf/gen/richter/v1/interactions_pb";
import { uploadConfig } from "@/lib/client-config";
import { ConnectError, Code } from "@connectrpc/connect";

// ── Types ───────────────────────────────────────────────────────────────────

type DialogState =
  | { phase: "form" }
  | { phase: "uploading"; progress: number; fileName: string }
  | { phase: "running"; taskId: string; lessonId: string; courseId: string }
  | { phase: "done"; lessonId: string; courseId: string }
  | { phase: "error"; errorMsg: string; stage: string; lessonId?: string; courseId?: string; taskId?: string };

interface AIConfig {
  difficulty: string;
  interactionKinds: InteractionKind[];
  countPerChunk: number;
  focusPrompt: string;
}

// ── Constants ────────────────────────────────────────────────────────────────

const ALLOWED_CONTENT_TYPES = new Set([
  "video/mp4",
  "video/webm",
  "video/ogg",
  "video/quicktime",
  "video/x-msvideo",
  "video/x-matroska",
]);

const POLL_INTERVAL_MS = 2000;

// ── Sub-components ───────────────────────────────────────────────────────────

function AIConfigPanel({
  config,
  onChange,
}: {
  config: AIConfig;
  onChange: (c: AIConfig) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);

  const difficultyOptions = [
    { value: "easy", label: "Dễ", cls: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-300" },
    { value: "medium", label: "Vừa", cls: "bg-blue-500/10 text-blue-600 dark:text-blue-300" },
    { value: "hard", label: "Khó", cls: "bg-amber-500/10 text-amber-600 dark:text-amber-300" },
  ];

  const kindOptions = [
    { kind: InteractionKind.SINGLE_CHOICE, label: "Trắc nghiệm MCQ" },
    { kind: InteractionKind.MULTIPLE_CHOICE, label: "Trắc nghiệm Multi" },
    { kind: InteractionKind.FILL_BLANK, label: "Điền vào chỗ trống" },
    { kind: InteractionKind.LISTENING, label: "Luyện nghe" },
    { kind: InteractionKind.READING, label: "Luyện đọc hiểu" },
  ];

  const handleKindToggle = (kind: InteractionKind) => {
    const { interactionKinds } = config;
    if (interactionKinds.includes(kind)) {
      if (interactionKinds.length > 1) {
        onChange({ ...config, interactionKinds: interactionKinds.filter((k) => k !== kind) });
      }
    } else {
      onChange({ ...config, interactionKinds: [...interactionKinds, kind] });
    }
  };

  return (
    <div className="rounded-xl border border-border/60 bg-card/30 backdrop-blur-md overflow-hidden shadow-sm transition-all duration-300">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-muted/30 transition-colors text-left"
      >
        <div className="flex items-center gap-2">
          <SlidersHorizontalIcon className="size-4 text-primary" />
          <span className="text-sm font-semibold text-foreground">Cài đặt AI nâng cao (Tùy chọn)</span>
        </div>
        {isOpen ? <ChevronUpIcon className="size-4 text-muted-foreground" /> : <ChevronDownIcon className="size-4 text-muted-foreground" />}
      </button>

      {isOpen && (
        <div className="border-t border-border/50 p-4 flex flex-col gap-4 bg-background/5 animate-in slide-in-from-top-1 duration-200">
          {/* Difficulty */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Mức độ khó</label>
            <div className="flex gap-2">
              {difficultyOptions.map((opt) => {
                const active = config.difficulty === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => onChange({ ...config, difficulty: opt.value })}
                    className={`px-3 py-1.5 text-xs font-semibold rounded-lg border transition-all ${
                      active
                        ? `${opt.cls} border-primary/50 shadow-sm ring-1 ring-primary/20`
                        : "border-border bg-transparent text-muted-foreground hover:bg-muted/40"
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Interaction kinds */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Loại bài tập</label>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {kindOptions.map((opt) => {
                const active = config.interactionKinds.includes(opt.kind);
                return (
                  <button
                    key={opt.kind}
                    type="button"
                    onClick={() => handleKindToggle(opt.kind)}
                    className={`flex items-center justify-center text-center p-2.5 rounded-lg border text-xs font-medium transition-all ${
                      active
                        ? "border-primary/50 bg-primary/10 text-primary shadow-sm"
                        : "border-border bg-transparent text-muted-foreground hover:bg-muted/40"
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Count per chunk */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
              Số câu hỏi / đoạn (0 = mặc định)
            </label>
            <Input
              type="number"
              min={0}
              max={20}
              value={config.countPerChunk}
              onChange={(e) => onChange({ ...config, countPerChunk: Math.max(0, Math.min(20, parseInt(e.target.value) || 0)) })}
              className="w-24 text-sm"
            />
          </div>

          {/* Focus prompt */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
              Focus Prompt (Trọng tâm nội dung)
            </label>
            <textarea
              rows={3}
              value={config.focusPrompt}
              onChange={(e) => onChange({ ...config, focusPrompt: e.target.value })}
              placeholder="Ví dụ: tập trung từ vựng IELTS, câu hỏi phân tích..."
              className="w-full text-xs rounded-lg border border-input bg-background/50 px-3 py-2 placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary transition-all resize-none"
            />
          </div>
        </div>
      )}
    </div>
  );
}

// 3-stage progress strip shown during pipeline run
function PipelineProgressStrip({ task }: { task: LessonTask | null }) {
  const stages: { key: string; label: string; step: string }[] = [
    { key: "TRANSCRIBING", label: "Phiên âm", step: "TRANSCRIBING" },
    { key: "CHUNKING", label: "Phân đoạn", step: "CHUNKING" },
    { key: "GENERATING", label: "Tạo bài tập", step: "GENERATING" },
  ];

  const progressStep = task?.progressStep ?? "";
  const isRunning = task?.status === LessonTaskStatus.RUNNING || task?.status === LessonTaskStatus.QUEUED;

  function getStageStatus(stage: (typeof stages)[number]): "pending" | "active" | "done" {
    if (!progressStep) return "pending";
    const idx = stages.findIndex((s) => s.step === stage.step);
    const currentIdx = stages.findIndex((s) => s.step === progressStep);
    if (idx < currentIdx) return "done";
    if (idx === currentIdx) return isRunning ? "active" : "done";
    return "pending";
  }

  return (
    <div className="flex items-center gap-2 px-1">
      {stages.map((stage, i) => {
        const status = getStageStatus(stage);
        return (
          <React.Fragment key={stage.key}>
            <div className="flex flex-col items-center gap-1 flex-1 min-w-0">
              <div
                className={cn(
                  "size-8 rounded-full flex items-center justify-center border-2 transition-all duration-300",
                  status === "done" && "border-emerald-500 bg-emerald-50 dark:bg-emerald-950 text-emerald-600",
                  status === "active" && "border-primary bg-primary/10 text-primary",
                  status === "pending" && "border-muted-foreground/30 bg-muted/30 text-muted-foreground",
                )}
              >
                {status === "done" ? (
                  <CheckCircleIcon className="size-4" />
                ) : status === "active" ? (
                  <Loader2Icon className="size-4 animate-spin" />
                ) : (
                  <span className="text-xs font-bold">{i + 1}</span>
                )}
              </div>
              <span
                className={cn(
                  "text-xs font-medium truncate w-full text-center",
                  status === "done" && "text-emerald-600",
                  status === "active" && "text-primary font-semibold",
                  status === "pending" && "text-muted-foreground",
                )}
              >
                {stage.label}
              </span>
            </div>
            {i < stages.length - 1 && (
              <div
                className={cn(
                  "h-px flex-1 transition-all duration-500",
                  getStageStatus(stages[i + 1]) !== "pending" ? "bg-emerald-400" : "bg-muted-foreground/20"
                )}
              />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

// ── Main dialog ──────────────────────────────────────────────────────────────

export interface QuickCreateLessonDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  token: string;
  modules: CourseModule[];
  courseId: string;
  slug: string;
}

export function QuickCreateLessonDialog({
  open,
  onOpenChange,
  token,
  modules,
  courseId,
  slug,
}: QuickCreateLessonDialogProps) {
  const router = useRouter();

  // RPC clients
  const storageClient = useRichterWebClient(StorageService, token);
  const lessonClient = useRichterWebClient(LessonService, token);
  const aiClient = useRichterWebClient(AIService, token);

  // Form state
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [selectedModuleId, setSelectedModuleId] = useState<string>(() => modules[0]?.id ?? "");
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [isDragActive, setIsDragActive] = useState(false);
  const [aiConfig, setAIConfig] = useState<AIConfig>({
    difficulty: "medium",
    interactionKinds: [InteractionKind.SINGLE_CHOICE],
    countPerChunk: 0,
    focusPrompt: "",
  });
  const [formError, setFormError] = useState<string | null>(null);

  // Dialog state machine
  const [dialogState, setDialogState] = useState<DialogState>({ phase: "form" });

  // For polling during "running" phase
  const [liveTask, setLiveTask] = useState<LessonTask | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Reset on close
  useEffect(() => {
    if (!open) {
      setTitle("");
      setDescription("");
      setSelectedModuleId(modules[0]?.id ?? "");
      setVideoFile(null);
      setFormError(null);
      setDialogState({ phase: "form" });
      setLiveTask(null);
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    }
  }, [open, modules]);

  // ── Polling while running ────────────────────────────────────────────────
  const startPolling = useCallback(
    (taskId: string, lessonId: string, thisCourseId: string) => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(async () => {
        try {
          const res = await aiClient.getLessonTask({ taskId });
          const t = res.task;
          if (!t) return;
          setLiveTask(t);

          if (t.status === LessonTaskStatus.SUCCEEDED) {
            clearInterval(pollRef.current!);
            pollRef.current = null;
            setDialogState({ phase: "done", lessonId, courseId: thisCourseId });
          } else if (
            t.status === LessonTaskStatus.FAILED ||
            t.status === LessonTaskStatus.CANCELED
          ) {
            clearInterval(pollRef.current!);
            pollRef.current = null;
            setDialogState({
              phase: "error",
              errorMsg: t.errorMsg || t.message || "Quy trình AI thất bại.",
              stage: t.progressStep || "UNKNOWN",
              lessonId,
              courseId: thisCourseId,
              taskId,
            });
          }
        } catch {
          // Network error — keep polling
        }
      }, POLL_INTERVAL_MS);
    },
    [aiClient],
  );

  // ── File handlers ────────────────────────────────────────────────────────
  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") setIsDragActive(true);
    else if (e.type === "dragleave") setIsDragActive(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragActive(false);
    const file = e.dataTransfer.files?.[0];
    if (file) selectVideoFile(file);
  };

  function selectVideoFile(file: File) {
    if (!file.type.startsWith("video/") || !ALLOWED_CONTENT_TYPES.has(file.type)) {
      setFormError("Chỉ hỗ trợ tệp video (MP4, WebM, MOV, MKV...).");
      return;
    }
    setFormError(null);
    setVideoFile(file);
  }

  // ── Submit ───────────────────────────────────────────────────────────────
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);

    if (!title.trim()) { setFormError("Vui lòng nhập tiêu đề bài học."); return; }
    if (!videoFile) { setFormError("Vui lòng chọn tệp video."); return; }
    if (!selectedModuleId) { setFormError("Vui lòng chọn chương học."); return; }

    // ── Step 1: Create lesson ──────────────────────────────────────────────
    let lessonId: string;
    let createdCourseId = courseId;
    try {
      const res = await lessonClient.createLesson({
        moduleId: selectedModuleId,
        title: title.trim(),
        description: description.trim(),
        orderIndex: 0,
      });
      lessonId = res.lesson?.id ?? "";
      if (!lessonId) throw new Error("Không tạo được bài học");
    } catch (err) {
      const msg = err instanceof ConnectError ? err.message : "Không thể tạo bài học.";
      setFormError(msg);
      return;
    }

    // ── Step 2: Upload video ───────────────────────────────────────────────
    setDialogState({ phase: "uploading", progress: 0, fileName: videoFile.name });

    const ext = videoFile.name.split(".").pop() ?? "mp4";
    const version =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const key = `lessons/${lessonId}/video/${version}.${ext}`;

    let uploadUrl: string;
    try {
      const res = await storageClient.getUploadUrl({
        key,
        contentType: videoFile.type || "video/mp4",
        expiresInSeconds: 3600,
      });
      uploadUrl = res.uploadUrl;
    } catch {
      setDialogState({
        phase: "error",
        errorMsg: "Không lấy được đường dẫn tải lên. Kiểm tra kết nối lưu trữ.",
        stage: "UPLOAD",
        lessonId,
        courseId: createdCourseId,
      });
      return;
    }

    let uploadOk = false;
    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.upload.addEventListener("progress", (ev) => {
        if (ev.lengthComputable)
          setDialogState({
            phase: "uploading",
            progress: Math.round((ev.loaded / ev.total) * 100),
            fileName: videoFile.name,
          });
      });
      xhr.addEventListener("load", () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(new Error(`Tải video thất bại (HTTP ${xhr.status})`));
      });
      xhr.addEventListener("error", () => reject(new Error("Lỗi mạng khi tải lên")));
      xhr.addEventListener("timeout", () => reject(new Error("Tải video quá thời gian.")));
      xhr.timeout = 600_000;
      xhr.open("PUT", uploadUrl);
      xhr.setRequestHeader("Content-Type", videoFile.type || "video/mp4");
      xhr.send(videoFile);
    })
      .then(() => {
        uploadOk = true;
      })
      .catch((err: Error) => {
        setDialogState({
          phase: "error",
          errorMsg: err.message,
          stage: "UPLOAD",
          lessonId,
          courseId: createdCourseId,
        });
      });

    if (!uploadOk) return;

    // Probe duration
    let durationSeconds = 0;
    try {
      durationSeconds = await new Promise<number>((resolve) => {
        const video = document.createElement("video");
        const objectUrl = URL.createObjectURL(videoFile);
        const cleanup = () => URL.revokeObjectURL(objectUrl);
        const timer = setTimeout(() => {
          cleanup();
          resolve(0);
        }, uploadConfig.uploadTimeoutMs);
        video.addEventListener("loadedmetadata", () => {
          clearTimeout(timer);
          cleanup();
          resolve(isFinite(video.duration) ? Math.round(video.duration) : 0);
        });
        video.addEventListener("error", () => {
          clearTimeout(timer);
          cleanup();
          resolve(0);
        });
        video.src = objectUrl;
      });
    } catch {
      durationSeconds = 0;
    }

    // Persist video key
    try {
      await lessonClient.updateLessonVideo({
        id: lessonId,
        videoStorageKey: key,
        durationSeconds,
      });
    } catch {
      setDialogState({
        phase: "error",
        errorMsg: "Không thể lưu thông tin video.",
        stage: "UPLOAD",
        lessonId,
        courseId: createdCourseId,
      });
      return;
    }

    // ── Step 3: Start pipeline task ────────────────────────────────────────
    let taskId: string;
    try {
      const res = await aiClient.startLessonTask({
        lessonId,
        kind: LessonTaskKind.RUN_PIPELINE,
        generateInteractions: {
          lessonId,
          chunkId: "",
          forceRegenerate: false,
          interactionKind: 0,
          interactionKinds: aiConfig.interactionKinds,
          countPerChunk: aiConfig.countPerChunk,
          strategy: 0,
          difficulty: aiConfig.difficulty,
          focusPrompt: aiConfig.focusPrompt,
        },
      });
      taskId = res.task?.id ?? "";
      if (!taskId) throw new Error("Không nhận được task id");
    } catch (err) {
      let errorMsg = "Không thể bắt đầu quy trình AI.";
      if (err instanceof ConnectError) {
        if (err.code === Code.ResourceExhausted) {
          errorMsg = err.message;
        } else {
          errorMsg = err.message;
        }
      }
      setDialogState({
        phase: "error",
        errorMsg,
        stage: "PIPELINE_START",
        lessonId,
        courseId: createdCourseId,
      });
      return;
    }

    setDialogState({ phase: "running", taskId, lessonId, courseId: createdCourseId });
    startPolling(taskId, lessonId, createdCourseId);
  }

  // ── Cancel ────────────────────────────────────────────────────────────────
  async function handleCancel() {
    if (dialogState.phase === "running" && dialogState.taskId) {
      try {
        await aiClient.cancelLessonTask({ taskId: dialogState.taskId });
      } catch {
        // Best-effort
      }
    }
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    onOpenChange(false);
  }

  // ── Navigate to lesson ────────────────────────────────────────────────────
  function navigateToLesson(lessonId: string, thisCourseId: string) {
    router.push(`/dashboard/organizations/${slug}/courses/${thisCourseId}/lessons/${lessonId}`);
    onOpenChange(false);
  }

  const canSubmit = title.trim().length > 0 && videoFile !== null && selectedModuleId.length > 0;

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <Dialog open={open} onOpenChange={(v) => {
      if (!v && (dialogState.phase === "uploading" || dialogState.phase === "running")) {
        // Don't close while actively running unless user confirms via Cancel button
        return;
      }
      onOpenChange(v);
    }}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ZapIcon className="size-5 text-primary" />
            Tạo nhanh bài học
          </DialogTitle>
        </DialogHeader>

        {/* ── Phase: form ── */}
        {dialogState.phase === "form" && (
          <form onSubmit={(e) => { void handleSubmit(e); }} className="flex flex-col gap-4 mt-2">
            {formError && (
              <div className="flex items-center gap-2 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                <AlertCircleIcon className="size-4 shrink-0" />
                <span>{formError}</span>
              </div>
            )}

            {/* Title */}
            <div className="space-y-1.5">
              <Label htmlFor="qc-title">Tiêu đề bài học <span className="text-destructive">*</span></Label>
              <Input
                id="qc-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Ví dụ: Bài 1 - Giới thiệu về Big-O"
                autoFocus
              />
            </div>

            {/* Description */}
            <div className="space-y-1.5">
              <Label htmlFor="qc-desc">Mô tả (tùy chọn)</Label>
              <Input
                id="qc-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Mô tả ngắn về nội dung bài học..."
              />
            </div>

            {/* Module select */}
            {modules.length > 0 && (
              <div className="space-y-1.5">
                <Label>Chương học <span className="text-destructive">*</span></Label>
                <Select value={selectedModuleId} onValueChange={setSelectedModuleId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Chọn chương học" />
                  </SelectTrigger>
                  <SelectContent>
                    {modules.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {m.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* Video drop-zone */}
            <div className="space-y-1.5">
              <Label>Video bài giảng <span className="text-destructive">*</span></Label>
              <input
                ref={fileInputRef}
                type="file"
                accept="video/*"
                className="hidden"
                data-testid="qc-video-input"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) selectVideoFile(f);
                  e.target.value = "";
                }}
              />

              {videoFile ? (
                <div className="flex items-center gap-3 rounded-lg border border-emerald-200 bg-emerald-50/50 dark:bg-emerald-950/10 px-3 py-2.5">
                  <FileVideo2Icon className="size-5 text-emerald-600 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-semibold text-foreground truncate">{videoFile.name}</p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">
                      {(videoFile.size / (1024 * 1024)).toFixed(2)} MB
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setVideoFile(null)}
                    className="text-muted-foreground hover:text-destructive transition-colors"
                  >
                    <XCircleIcon className="size-4" />
                  </button>
                </div>
              ) : (
                <div
                  onDragEnter={handleDrag}
                  onDragOver={handleDrag}
                  onDragLeave={handleDrag}
                  onDrop={handleDrop}
                  onClick={() => fileInputRef.current?.click()}
                  className={cn(
                    "relative group flex flex-col items-center justify-center p-5 border-2 border-dashed rounded-lg cursor-pointer transition-all duration-300",
                    isDragActive
                      ? "border-primary bg-primary/5 scale-[1.01] shadow-sm"
                      : "border-muted-foreground/20 bg-card/60 hover:border-primary/40 hover:bg-muted/10",
                  )}
                >
                  <div className={cn(
                    "rounded-full p-2.5 transition-colors mb-2",
                    isDragActive ? "bg-primary/20 text-primary" : "bg-muted text-muted-foreground group-hover:bg-primary/10 group-hover:text-primary"
                  )}>
                    <UploadCloudIcon className="size-5" />
                  </div>
                  <p className="text-xs font-semibold text-foreground text-center">
                    {isDragActive ? "Thả tệp vào đây" : "Kéo thả tệp video vào đây"}
                  </p>
                  <p className="text-[10px] text-muted-foreground mt-1 text-center">
                    Hoặc nhấp để chọn · MP4, WebM, MOV, MKV...
                  </p>
                </div>
              )}
            </div>

            {/* AI config panel */}
            <AIConfigPanel config={aiConfig} onChange={setAIConfig} />

            {/* Actions */}
            <div className="flex gap-2 justify-end pt-1">
              <Button
                type="button"
                variant="ghost"
                onClick={() => onOpenChange(false)}
              >
                Hủy
              </Button>
              <Button
                type="submit"
                disabled={!canSubmit}
                className="gap-2"
              >
                <ZapIcon className="size-4" />
                Tạo &amp; Phân tích ngay
              </Button>
            </div>
          </form>
        )}

        {/* ── Phase: uploading ── */}
        {dialogState.phase === "uploading" && (
          <div className="flex flex-col gap-4 mt-4">
            <div className="flex items-center gap-3 rounded-lg border bg-muted/10 p-4">
              <div className="rounded bg-primary/10 p-2 text-primary">
                <FileVideo2Icon className="size-5 shrink-0" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold truncate">{dialogState.fileName}</p>
                <div className="mt-2 flex flex-col gap-1.5">
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span className="flex items-center gap-1.5 font-medium text-foreground">
                      <Loader2Icon className="size-3 animate-spin text-primary" />
                      Đang tải video lên máy chủ...
                    </span>
                    <span className="font-semibold">{dialogState.progress}%</span>
                  </div>
                  <div className="relative w-full h-2 rounded-full bg-muted overflow-hidden">
                    <div
                      className="absolute h-full rounded-full bg-gradient-to-r from-blue-500 via-indigo-500 to-purple-600 transition-all duration-300 ease-out"
                      style={{ width: `${dialogState.progress}%` }}
                    />
                  </div>
                </div>
              </div>
            </div>
            <p className="text-xs text-muted-foreground text-center">
              Vui lòng không đóng cửa sổ này trong khi tải lên...
            </p>
          </div>
        )}

        {/* ── Phase: running ── */}
        {dialogState.phase === "running" && (
          <div className="flex flex-col gap-5 mt-4">
            <div className="text-center">
              <p className="text-sm font-semibold text-foreground">Đang xử lý bài học</p>
              <p className="text-xs text-muted-foreground mt-1">
                AI đang chạy toàn bộ quy trình. Bạn có thể đóng hộp thoại và quay lại sau.
              </p>
            </div>

            <PipelineProgressStrip task={liveTask} />

            {liveTask?.message && (
              <div className="flex items-center gap-2 rounded-lg border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                <Loader2Icon className="size-3 animate-spin shrink-0 text-primary" />
                <span>{liveTask.message}</span>
              </div>
            )}

            <div className="flex gap-2 justify-end">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void handleCancel()}
              >
                Hủy tác vụ
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  if (dialogState.phase === "running") {
                    navigateToLesson(dialogState.lessonId, dialogState.courseId);
                  }
                }}
              >
                Xem bài học
                <ArrowRightIcon className="size-3.5 ml-1" />
              </Button>
            </div>
          </div>
        )}

        {/* ── Phase: done ── */}
        {dialogState.phase === "done" && (
          <div className="flex flex-col items-center gap-4 py-6">
            <div className="size-16 rounded-full bg-emerald-50 dark:bg-emerald-950/30 flex items-center justify-center border-2 border-emerald-200 dark:border-emerald-800">
              <CheckCircleIcon className="size-8 text-emerald-500" />
            </div>
            <div className="text-center">
              <p className="text-base font-semibold text-foreground">Hoàn thành!</p>
              <p className="text-xs text-muted-foreground mt-1">
                Bài học đã được tạo và phân tích xong. Câu hỏi luyện tập đã sẵn sàng.
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => onOpenChange(false)}
              >
                Đóng
              </Button>
              <Button
                size="sm"
                className="gap-2"
                onClick={() => navigateToLesson(dialogState.lessonId, dialogState.courseId)}
              >
                <ArrowRightIcon className="size-4" />
                Vào bài học
              </Button>
            </div>
          </div>
        )}

        {/* ── Phase: error ── */}
        {dialogState.phase === "error" && (
          <div className="flex flex-col gap-4 mt-4">
            <div className="flex items-start gap-3 rounded-lg border border-destructive/20 bg-destructive/5 p-4">
              <AlertCircleIcon className="size-5 text-destructive shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-foreground">Đã xảy ra lỗi</p>
                {dialogState.stage && dialogState.stage !== "UPLOAD" && (
                  <Badge variant="outline" className="text-[10px] mt-1 mb-1.5">
                    Giai đoạn: {dialogState.stage}
                  </Badge>
                )}
                <p className="text-xs text-muted-foreground mt-1 break-words">{dialogState.errorMsg}</p>
              </div>
            </div>

            <div className="flex gap-2 justify-end">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  if (dialogState.lessonId && dialogState.courseId) {
                    navigateToLesson(dialogState.lessonId, dialogState.courseId);
                  } else {
                    onOpenChange(false);
                  }
                }}
              >
                Xem bài học
              </Button>
              {dialogState.taskId && (
                <Button
                  size="sm"
                  className="gap-2"
                  onClick={async () => {
                    // Retry: start a new pipeline task
                    if (dialogState.lessonId) {
                      try {
                        const res = await aiClient.startLessonTask({
                          lessonId: dialogState.lessonId,
                          kind: LessonTaskKind.RUN_PIPELINE,
                          generateInteractions: {
                            lessonId: dialogState.lessonId,
                            chunkId: "",
                            forceRegenerate: true,
                            interactionKind: 0,
                            interactionKinds: aiConfig.interactionKinds,
                            countPerChunk: aiConfig.countPerChunk,
                            strategy: 0,
                            difficulty: aiConfig.difficulty,
                            focusPrompt: aiConfig.focusPrompt,
                          },
                        });
                        const newTaskId = res.task?.id ?? "";
                        if (newTaskId) {
                          setLiveTask(null);
                          setDialogState({
                            phase: "running",
                            taskId: newTaskId,
                            lessonId: dialogState.lessonId,
                            courseId: dialogState.courseId ?? courseId,
                          });
                          startPolling(newTaskId, dialogState.lessonId, dialogState.courseId ?? courseId);
                        }
                      } catch (err) {
                        const msg = err instanceof ConnectError ? err.message : "Không thể thử lại.";
                        setDialogState({ ...dialogState, errorMsg: msg });
                      }
                    }
                  }}
                >
                  <RefreshCcwIcon className="size-3.5" />
                  Thử lại
                </Button>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
