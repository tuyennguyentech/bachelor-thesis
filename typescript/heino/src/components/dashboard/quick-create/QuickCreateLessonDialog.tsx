"use client";

import React, { useEffect, useRef, useState } from "react";
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
  AlertCircleIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  SlidersHorizontalIcon,
  XCircleIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useRichterWebClient } from "@/lib/connect-webclient";
import { StorageService } from "buf/gen/richter/v1/storage_pb";
import {
  LessonService,
  type CourseModule,
} from "buf/gen/richter/v1/courses_pb";
import { AIService, LessonTaskKind, GenerationStrategy } from "buf/gen/richter/v1/ai_pb";
import { FeedbackMode } from "buf/gen/richter/v1/interactions_pb";
import {
  KindQuantityGrid,
  emptyQuantities,
  toKindsList,
  totalQuantity,
  type KindQuantities,
} from "@/app/dashboard/organizations/[slug]/courses/[courseId]/lessons/[lessonId]/kind-quantity-grid";
import { uploadConfig } from "@/lib/client-config";
import { ConnectError } from "@connectrpc/connect";

// ── Types ───────────────────────────────────────────────────────────────────
// The dialog only OWNS the pre-pipeline steps (configure → upload → start task).
// Once the durable RUN_PIPELINE task is started, it navigates to the lesson's
// processing tab, which renders the live, durable progress — so there is no
// blocking "running"/"done" phase here.
type DialogState =
  | { phase: "form" }
  | { phase: "uploading"; progress: number; fileName: string }
  | { phase: "error"; errorMsg: string; stage: string; lessonId?: string };

const ALLOWED_CONTENT_TYPES = new Set([
  "video/mp4",
  "video/webm",
  "video/ogg",
  "video/quicktime",
  "video/x-msvideo",
  "video/x-matroska",
]);

// Used for both the question/output language and the spoken-audio language. The
// audio language is always a concrete choice (vi/en) — the old "Tự động" option
// was removed; transcription always sends a concrete language hint to Whisper.
const LANGUAGE_OPTIONS = [
  { value: "vi", label: "🇻🇳 Tiếng Việt" },
  { value: "en", label: "🇬🇧 English" },
];

const FEEDBACK_OPTIONS = [
  { value: FeedbackMode.AFTER_SUBMIT, label: "Hiện đáp án sau khi nộp" },
  { value: FeedbackMode.AFTER_EACH, label: "Hiện đáp án sau mỗi câu" },
  { value: FeedbackMode.HIDDEN, label: "Ẩn đáp án" },
];

// ── Advanced AI config (collapsible) ─────────────────────────────────────────

interface AdvancedConfig {
  difficulty: string;
  focusPrompt: string;
  quantities: KindQuantities;
  maxAttempts: number;
  feedbackMode: FeedbackMode;
}

function AIConfigPanel({
  config,
  onChange,
}: {
  config: AdvancedConfig;
  onChange: (c: AdvancedConfig) => void;
}) {
  const [isOpen, setIsOpen] = useState(true);

  const difficultyOptions = [
    { value: "easy", label: "Dễ", cls: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-300" },
    { value: "medium", label: "Vừa", cls: "bg-blue-500/10 text-blue-600 dark:text-blue-300" },
    { value: "hard", label: "Khó", cls: "bg-amber-500/10 text-amber-600 dark:text-amber-300" },
  ];

  return (
    <div className="rounded-xl border border-border/60 bg-card/30 overflow-hidden shadow-sm">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-muted/30 transition-colors text-left"
      >
        <div className="flex items-center gap-2">
          <SlidersHorizontalIcon className="size-4 text-primary" />
          <span className="text-sm font-semibold text-foreground">Cấu hình bài tập</span>
        </div>
        {isOpen ? <ChevronUpIcon className="size-4 text-muted-foreground" /> : <ChevronDownIcon className="size-4 text-muted-foreground" />}
      </button>

      {isOpen && (
        <div className="border-t border-border/50 p-4 flex flex-col gap-4">
          {/* Per-kind quantities — the same control as the real "tạo bài tập" step */}
          <KindQuantityGrid
            value={config.quantities}
            onChange={(quantities) => onChange({ ...config, quantities })}
            helperText="Số câu mỗi loại, áp dụng cho từng phân đoạn của bài giảng."
          />

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
                      active ? `${opt.cls} border-primary/50 ring-1 ring-primary/20` : "border-border text-muted-foreground hover:bg-muted/40"
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Max attempts + feedback mode */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="qc-attempts" className="text-xs">Số lần làm (0 = không giới hạn)</Label>
              <Input
                id="qc-attempts"
                type="number"
                min={0}
                max={99}
                value={config.maxAttempts}
                onChange={(e) => onChange({ ...config, maxAttempts: Math.max(0, Math.min(99, parseInt(e.target.value) || 0)) })}
                className="text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Hiện kết quả</Label>
              <Select
                value={String(config.feedbackMode)}
                onValueChange={(v) => onChange({ ...config, feedbackMode: Number(v) as FeedbackMode })}
              >
                <SelectTrigger className="text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FEEDBACK_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={String(o.value)}>{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Focus prompt */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
              Trọng tâm nội dung (tùy chọn)
            </label>
            <textarea
              rows={2}
              value={config.focusPrompt}
              onChange={(e) => onChange({ ...config, focusPrompt: e.target.value })}
              placeholder="Ví dụ: tập trung từ vựng IELTS, câu hỏi phân tích..."
              className="w-full text-xs rounded-lg border border-input bg-background/50 px-3 py-2 placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary resize-none"
            />
          </div>
        </div>
      )}
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
  /**
   * When set, Quick Create runs against an EXISTING (video-less) lesson instead
   * of creating a new one — used by the "tạo nhanh" button on a lesson's video
   * tab. Title/module pickers are hidden in that mode.
   */
  existingLesson?: { id: string; title: string };
}

export function QuickCreateLessonDialog({
  open,
  onOpenChange,
  token,
  modules,
  courseId,
  slug,
  existingLesson,
}: QuickCreateLessonDialogProps) {
  const storageClient = useRichterWebClient(StorageService, token);
  const lessonClient = useRichterWebClient(LessonService, token);
  const aiClient = useRichterWebClient(AIService, token);

  const isExisting = !!existingLesson;

  // Form state
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [selectedModuleId, setSelectedModuleId] = useState<string>(() => modules[0]?.id ?? "");
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [isDragActive, setIsDragActive] = useState(false);
  const [language, setLanguage] = useState("vi");
  // Spoken/audio language of the uploaded video — drives the transcription hint
  // (separate from `language`, the question/output language). Always a concrete
  // choice (vi/en); defaults to Vietnamese, the platform's primary language.
  const [audioLanguage, setAudioLanguage] = useState("vi");
  const [config, setConfig] = useState<AdvancedConfig>({
    difficulty: "medium",
    focusPrompt: "",
    quantities: emptyQuantities(),
    maxAttempts: 0,
    feedbackMode: FeedbackMode.AFTER_SUBMIT,
  });
  const [formError, setFormError] = useState<string | null>(null);

  const [dialogState, setDialogState] = useState<DialogState>({ phase: "form" });
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Reset on close
  useEffect(() => {
    if (!open) {
      setTitle("");
      setDescription("");
      setSelectedModuleId(modules[0]?.id ?? "");
      setVideoFile(null);
      setLanguage("vi");
      setAudioLanguage("vi");
      setConfig({
        difficulty: "medium",
        focusPrompt: "",
        quantities: emptyQuantities(),
        maxAttempts: 0,
        feedbackMode: FeedbackMode.AFTER_SUBMIT,
      });
      setFormError(null);
      setDialogState({ phase: "form" });
    }
  }, [open, modules]);

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

  // ── Navigate to the lesson's processing tab (durable progress lives there) ──
  function goToProcessing(lessonId: string) {
    onOpenChange(false);
    // Deterministic FULL-DOCUMENT navigation. A soft router.push here only changes
    // the ?tab= query on the SAME route segment, which the App Router can serve from
    // the client Router Cache WITHOUT re-running the Server Component → the
    // just-uploaded videoStorageKey/videoUrl + activeTab stay stale (content tab
    // frozen on "Chưa có video", stepper stuck at step 1, task poller disabled — the
    // reported freeze). router.refresh() cannot be reliably sequenced after
    // router.push (the push transition supersedes it), so we hard-navigate — exactly
    // what the manual reload that "fixes" it does today, but automatic + race-free.
    // Fires once at hand-off (not per tab-switch), so it doesn't reintroduce the
    // heavy per-switch reload the client tabs were designed to avoid.
    window.location.assign(`/dashboard/organizations/${slug}/courses/${courseId}/lessons/${lessonId}?tab=processing`);
  }

  // ── Submit ───────────────────────────────────────────────────────────────
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);

    if (!isExisting && !title.trim()) { setFormError("Vui lòng nhập tiêu đề bài học."); return; }
    if (!videoFile) { setFormError("Vui lòng chọn tệp video."); return; }
    if (!isExisting && !selectedModuleId) { setFormError("Vui lòng chọn chương học."); return; }

    // ── Step 1: Resolve the lesson (create a new one, or use the existing) ──
    let lessonId: string;
    if (isExisting) {
      lessonId = existingLesson!.id;
    } else {
      try {
        const res = await lessonClient.createLesson({
          moduleId: selectedModuleId,
          title: title.trim(),
          description: description.trim(),
          orderIndex: 0,
          maxAttempts: config.maxAttempts,
        });
        lessonId = res.lesson?.id ?? "";
        if (!lessonId) throw new Error("Không tạo được bài học");
      } catch (err) {
        setFormError(err instanceof ConnectError ? err.message : "Không thể tạo bài học.");
        return;
      }
    }

    // ── Step 2: Persist lesson settings (language + attempts + feedback) ────
    // Language is a LESSON attribute that the question generator reads from the
    // lesson row — Quick Create previously skipped it, silently degrading
    // generation. Set it (and attempts/feedback) before starting the pipeline.
    try {
      await lessonClient.updateLesson({
        id: lessonId,
        title: isExisting ? existingLesson!.title : title.trim(),
        description: description.trim(),
        orderIndex: 0,
        language,
        audioLanguage,
        maxAttempts: config.maxAttempts,
      });
      await lessonClient.updateLessonFeedbackMode({ id: lessonId, feedbackMode: config.feedbackMode });
    } catch (err) {
      setFormError(err instanceof ConnectError ? err.message : "Không thể lưu cấu hình bài học.");
      return;
    }

    // ── Step 3: Upload video ───────────────────────────────────────────────
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
      setDialogState({ phase: "error", errorMsg: "Không lấy được đường dẫn tải lên. Kiểm tra kết nối lưu trữ.", stage: "UPLOAD", lessonId });
      return;
    }

    let uploadOk = false;
    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.upload.addEventListener("progress", (ev) => {
        if (ev.lengthComputable)
          setDialogState({ phase: "uploading", progress: Math.round((ev.loaded / ev.total) * 100), fileName: videoFile.name });
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
        setDialogState({ phase: "error", errorMsg: err.message, stage: "UPLOAD", lessonId });
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

    try {
      await lessonClient.updateLessonVideo({ id: lessonId, videoStorageKey: key, durationSeconds });
    } catch {
      setDialogState({ phase: "error", errorMsg: "Không thể lưu thông tin video.", stage: "UPLOAD", lessonId });
      return;
    }

    // ── Step 4: Start the durable pipeline task, then navigate to processing ──
    try {
      await aiClient.startLessonTask({
        lessonId,
        kind: LessonTaskKind.RUN_PIPELINE,
        generateInteractions: {
          lessonId,
          chunkId: "",
          forceRegenerate: false,
          interactionKind: 0,
          // toKindsList expands the per-kind quantities into a flat repeated list
          // (1 entry per intended question). countPerChunk MUST equal the total so
          // the EVEN_DISTRIBUTION reconstruction on the backend walks every entry
          // (cfgKinds[i % len]); sending 0 collapses it to the chunk default (1)
          // and only the first kind gets generated.
          interactionKinds: toKindsList(config.quantities),
          countPerChunk: totalQuantity(config.quantities),
          strategy: GenerationStrategy.EVEN_DISTRIBUTION,
          difficulty: config.difficulty,
          focusPrompt: config.focusPrompt,
        },
      });
    } catch (err) {
      setDialogState({ phase: "error", errorMsg: err instanceof ConnectError ? err.message : "Không thể bắt đầu quy trình AI.", stage: "PIPELINE_START", lessonId });
      return;
    }

    // The task runs server-side (durable). Hand off to the processing tab which
    // shows live progress and auto-runs every stage — no further clicks needed.
    goToProcessing(lessonId);
  }

  const canSubmit = (isExisting || (title.trim().length > 0 && selectedModuleId.length > 0)) && videoFile !== null;

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v && dialogState.phase === "uploading") return; // don't close mid-upload
        onOpenChange(v);
      }}
    >
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ZapIcon className="size-5 text-primary" />
            {isExisting ? `Tạo nhanh: ${existingLesson!.title}` : "Tạo nhanh bài học"}
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

            {!isExisting && (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="qc-title">Tiêu đề bài học <span className="text-destructive">*</span></Label>
                  <Input id="qc-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ví dụ: Bài 1 - Giới thiệu về Big-O" autoFocus />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="qc-desc">Mô tả (tùy chọn)</Label>
                  <Input id="qc-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Mô tả ngắn về nội dung bài học..." />
                </div>

                {modules.length > 0 && (
                  <div className="space-y-1.5">
                    <Label>Chương học <span className="text-destructive">*</span></Label>
                    <Select value={selectedModuleId} onValueChange={setSelectedModuleId}>
                      <SelectTrigger>
                        <SelectValue placeholder="Chọn chương học" />
                      </SelectTrigger>
                      <SelectContent>
                        {modules.map((m) => (
                          <SelectItem key={m.id} value={m.id}>{m.title}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </>
            )}

            {/* Question/output language (the generator reads it from the lesson) */}
            <div className="space-y-1.5">
              <Label>Ngôn ngữ câu hỏi <span className="text-destructive">*</span></Label>
              <Select value={language} onValueChange={setLanguage}>
                <SelectTrigger data-testid="qc-language">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LANGUAGE_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Audio/spoken language of the video (drives the transcription hint) */}
            <div className="space-y-1.5">
              <Label>Ngôn ngữ âm thanh (giọng nói trong video) <span className="text-destructive">*</span></Label>
              <Select value={audioLanguage} onValueChange={setAudioLanguage}>
                <SelectTrigger data-testid="qc-audio-language">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LANGUAGE_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">
                Chọn đúng ngôn ngữ nói trong video để phiên âm chính xác (tách biệt với ngôn ngữ câu hỏi).
              </p>
            </div>

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
                    <p className="text-[10px] text-muted-foreground mt-0.5">{(videoFile.size / (1024 * 1024)).toFixed(2)} MB</p>
                  </div>
                  <button type="button" onClick={() => setVideoFile(null)} className="text-muted-foreground hover:text-destructive transition-colors">
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
                    isDragActive ? "border-primary bg-primary/5" : "border-muted-foreground/20 bg-card/60 hover:border-primary/40 hover:bg-muted/10",
                  )}
                >
                  <div className={cn("rounded-full p-2.5 transition-colors mb-2", isDragActive ? "bg-primary/20 text-primary" : "bg-muted text-muted-foreground group-hover:bg-primary/10 group-hover:text-primary")}>
                    <UploadCloudIcon className="size-5" />
                  </div>
                  <p className="text-xs font-semibold text-foreground text-center">{isDragActive ? "Thả tệp vào đây" : "Kéo thả tệp video vào đây"}</p>
                  <p className="text-[10px] text-muted-foreground mt-1 text-center">Hoặc nhấp để chọn · MP4, WebM, MOV, MKV...</p>
                </div>
              )}
            </div>

            {/* Advanced AI / exercise config */}
            <AIConfigPanel config={config} onChange={setConfig} />

            <div className="flex gap-2 justify-end pt-1">
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Hủy</Button>
              <Button type="submit" disabled={!canSubmit || totalQuantity(config.quantities) === 0} className="gap-2">
                <ZapIcon className="size-4" />
                Tạo &amp; chạy ngay
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
                      Đang tải video & khởi động xử lý...
                    </span>
                    <span className="font-semibold">{dialogState.progress}%</span>
                  </div>
                  <div className="relative w-full h-2 rounded-full bg-muted overflow-hidden">
                    <div className="absolute h-full rounded-full bg-gradient-to-r from-blue-500 via-indigo-500 to-purple-600 transition-all duration-300 ease-out" style={{ width: `${dialogState.progress}%` }} />
                  </div>
                </div>
              </div>
            </div>
            <p className="text-xs text-muted-foreground text-center">
              Sau khi tải xong sẽ tự chuyển sang trang xử lý và chạy toàn bộ các bước.
            </p>
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
                  <Badge variant="outline" className="text-[10px] mt-1 mb-1.5">Giai đoạn: {dialogState.stage}</Badge>
                )}
                <p className="text-xs text-muted-foreground mt-1 break-words">{dialogState.errorMsg}</p>
              </div>
            </div>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" size="sm" onClick={() => setDialogState({ phase: "form" })}>Thử lại</Button>
              {dialogState.lessonId && (
                <Button size="sm" onClick={() => goToProcessing(dialogState.lessonId!)}>Xem bài học</Button>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
