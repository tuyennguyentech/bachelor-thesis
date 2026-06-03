"use client";

import { useState } from "react";
import {
  SparklesIcon, Loader2Icon, Layers3Icon, ListChecksIcon, SlidersHorizontalIcon,
  RotateCcwIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { KindQuantityGrid, totalQuantity, type KindQuantities } from "./kind-quantity-grid";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  chunksCount: number;
  chunksWithExercisesCount: number;
  chunksWithConfigCount: number;
  interactionsCount: number;
  defaultQuantities: KindQuantities;
  onDefaultQuantitiesChange: (q: KindQuantities) => void;
  isGenerating: boolean;
  onGenerate: (force: boolean, difficulty: string, focusPrompt: string) => void;
}

export function GenerateExercisesDialog({
  open, onOpenChange,
  chunksCount, chunksWithExercisesCount, chunksWithConfigCount, interactionsCount,
  defaultQuantities, onDefaultQuantitiesChange,
  isGenerating, onGenerate,
}: Props) {
  const [difficulty, setDifficulty] = useState("medium");
  const [focusPrompt, setFocusPrompt] = useState("");
  const [force, setForce] = useState(interactionsCount > 0);

  const configTotal = totalQuantity(defaultQuantities);

  function handleGenerate() {
    onGenerate(force, difficulty, focusPrompt);
  }

  const targetChunksCount = force
    ? chunksCount
    : Math.max(0, chunksCount - chunksWithExercisesCount);
  const estimatedTotal = configTotal * targetChunksCount;
  const difficultyOptions = [
    { value: "easy", label: "Dễ", desc: "Ôn khái niệm", cls: "border-emerald-400/50 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300" },
    { value: "medium", label: "Vừa", desc: "Hiểu và áp dụng", cls: "border-blue-400/50 bg-blue-500/10 text-blue-600 dark:text-blue-300" },
    { value: "hard", label: "Khó", desc: "Phân tích sâu", cls: "border-amber-400/50 bg-amber-500/10 text-amber-600 dark:text-amber-300" },
  ];

  return (
    <Dialog open={open} onOpenChange={(o) => !isGenerating && onOpenChange(o)}>
      <DialogContent className="w-[min(1040px,calc(100vw-2rem))] gap-0 overflow-hidden rounded-2xl border-border/80 bg-popover p-0 shadow-2xl !max-w-[calc(100vw-2rem)] sm:!max-w-5xl">
        <DialogHeader className="border-b border-border/70 bg-[linear-gradient(135deg,hsl(var(--primary)/0.14),hsl(var(--background)),hsl(var(--muted)/0.55))] px-6 py-5">
          <DialogTitle className="flex items-center gap-3 text-lg">
            <div className="rounded-xl bg-primary/15 p-2.5 ring-1 ring-primary/20">
              <SparklesIcon className="size-5 text-primary" />
            </div>
            <div className="flex flex-col gap-1">
              <span>Tạo bài tập bằng AI</span>
              <span className="text-xs font-normal text-muted-foreground">
                Cấu hình số lượng, độ khó và phạm vi tạo cho toàn bài học.
              </span>
            </div>
          </DialogTitle>
        </DialogHeader>

        <div className="grid max-h-[calc(100vh-10.5rem)] gap-5 overflow-y-auto p-6 lg:grid-cols-[minmax(0,1fr)_340px]">
          <section className="rounded-2xl border border-border bg-muted/10 p-5">
            <KindQuantityGrid
              value={defaultQuantities}
              onChange={onDefaultQuantitiesChange}
              disabled={isGenerating}
              helperText="Áp dụng cho mỗi phân đoạn được tạo trong lần chạy này."
            />
          </section>

          <aside className="flex min-w-0 flex-col gap-4">
            <div className="grid grid-cols-3 gap-2">
              <div className="rounded-xl border border-sky-400/20 bg-sky-500/10 px-3 py-3">
                <div className="mb-2 flex items-center gap-1.5 text-sky-600 dark:text-sky-300">
                  <Layers3Icon className="size-3.5" />
                  <span className="text-[11px] font-medium">Đoạn</span>
                </div>
                <span className="block text-2xl font-bold tabular-nums">{chunksCount}</span>
              </div>
              <div className="rounded-xl border border-violet-400/20 bg-violet-500/10 px-3 py-3">
                <div className="mb-2 flex items-center gap-1.5 text-violet-600 dark:text-violet-300">
                  <ListChecksIcon className="size-3.5" />
                  <span className="text-[11px] font-medium">Có bài</span>
                </div>
                <span className="block text-2xl font-bold tabular-nums">{chunksWithExercisesCount}</span>
              </div>
              <div className="rounded-xl border border-emerald-400/20 bg-emerald-500/10 px-3 py-3">
                <div className="mb-2 flex items-center gap-1.5 text-emerald-600 dark:text-emerald-300">
                  <SlidersHorizontalIcon className="size-3.5" />
                  <span className="text-[11px] font-medium">Riêng</span>
                </div>
                <span className="block text-2xl font-bold tabular-nums">{chunksWithConfigCount}</span>
              </div>
            </div>

            <div className="rounded-2xl border border-border bg-background p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <span className="text-sm font-semibold">Độ khó</span>
                <span className="rounded-full bg-muted px-2 py-1 text-xs text-muted-foreground">
                  {difficultyOptions.find((item) => item.value === difficulty)?.label}
                </span>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {difficultyOptions.map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    onClick={() => setDifficulty(item.value)}
                    className={`flex min-h-[68px] flex-col items-center justify-center gap-1 rounded-xl border px-2 py-3 text-center text-sm font-medium transition-colors ${
                      difficulty === item.value
                        ? `${item.cls} shadow-sm`
                        : "border-border/70 bg-muted/20 text-muted-foreground hover:bg-muted/40"
                    }`}
                  >
                    <span className="font-semibold">{item.label}</span>
                    <span className="text-xs opacity-75">{item.desc}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="rounded-2xl border border-border bg-background p-4">
              <label htmlFor="gen-focus-prompt" className="text-sm font-semibold">
                Trọng tâm nội dung
                <span className="font-normal text-muted-foreground ml-1">(tuỳ chọn)</span>
              </label>
              <textarea
                id="gen-focus-prompt"
                value={focusPrompt}
                onChange={(e) => setFocusPrompt(e.target.value)}
                placeholder="Ví dụ: tập trung vào workflow, secrets; tránh câu hỏi ghi nhớ máy móc."
                rows={4}
                className="mt-2 w-full resize-none rounded-xl border border-input bg-muted/10 px-3 py-2.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>

            {interactionsCount > 0 && (
              <label className="flex cursor-pointer select-none items-start gap-3 rounded-2xl border border-amber-400/25 bg-amber-500/10 px-4 py-3 transition-colors hover:bg-amber-500/15">
                <input
                  type="checkbox"
                  checked={force}
                  onChange={(e) => setForce(e.target.checked)}
                  className="mt-0.5 size-4 rounded border-input text-primary focus:ring-primary"
                />
                <span className="text-sm">
                  <span className="flex items-center gap-1.5 font-medium">
                    <RotateCcwIcon className="size-3.5" />
                    Tạo lại ở đoạn đã có bài
                  </span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    Nếu tắt, các phân đoạn đã có bài tập sẽ được bỏ qua.
                  </span>
                </span>
              </label>
            )}

            <div className="rounded-2xl border border-primary/20 bg-primary/10 p-4">
              <span className="text-xs font-medium text-primary">Dự kiến tạo</span>
              <div className="mt-1 flex items-end gap-2">
                <span className="text-3xl font-bold tabular-nums">{estimatedTotal}</span>
                <span className="pb-1 text-sm text-muted-foreground">bài tập</span>
              </div>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                {configTotal} câu cho mỗi phân đoạn, áp dụng trên {targetChunksCount} phân đoạn.
              </p>
            </div>
          </aside>
        </div>

        <DialogFooter className="items-center border-t border-border/70 bg-muted/10 px-6 py-4 sm:justify-between">
          <div className="hidden text-sm text-muted-foreground sm:block">
            <span className="font-medium text-foreground">{configTotal}</span> câu / phân đoạn
            <span className="mx-2">·</span>
            <span className="font-medium text-foreground">{estimatedTotal}</span> bài tập dự kiến
          </div>
          <div className="flex w-full flex-col-reverse gap-2 sm:w-auto sm:flex-row">
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isGenerating} className="rounded-xl">
              Hủy
            </Button>
            <Button
              onClick={handleGenerate}
              disabled={isGenerating || configTotal === 0}
              className="gap-2 rounded-xl px-6"
            >
              {isGenerating ? (
                <>
                  <Loader2Icon className="size-4 animate-spin" />
                  Đang tạo...
                </>
              ) : (
                <>
                  <SparklesIcon className="size-4" />
                  Tạo {estimatedTotal} bài tập
                </>
              )}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
