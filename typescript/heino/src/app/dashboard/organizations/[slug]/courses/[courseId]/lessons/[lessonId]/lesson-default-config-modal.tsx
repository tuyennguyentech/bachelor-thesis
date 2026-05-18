"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Loader2Icon } from "lucide-react";
import type { ChunkInteractionConfig } from "buf/gen/richter/v1/ai_pb";
import { GenerationStrategy, AIService, ChunkInteractionConfigSchema } from "buf/gen/richter/v1/ai_pb";
import { create } from "@bufbuild/protobuf";
import { InteractionKind } from "buf/gen/richter/v1/interactions_pb";
import { useRichterWebClient } from "@/lib/connect-webclient";
import { ConnectError } from "@connectrpc/connect";

const KIND_OPTIONS = [
  { kind: InteractionKind.MCQ, label: "Trắc nghiệm" },
  { kind: InteractionKind.FILL_BLANK, label: "Điền đáp án" },
  { kind: InteractionKind.READING, label: "Bài đọc" },
  { kind: InteractionKind.LISTENING, label: "Bài nghe" },
];

interface Props {
  open: boolean;
  onClose: () => void;
  lessonId: string;
  token: string;
  initialConfig?: ChunkInteractionConfig;
  onSaved: (cfg: ChunkInteractionConfig) => void;
}

export function LessonDefaultConfigModal({ open, onClose, lessonId, token, initialConfig, onSaved }: Props) {
  const aiClient = useRichterWebClient(AIService, token);

  const [count, setCount] = useState(initialConfig?.count ?? 2);
  const [kinds, setKinds] = useState<InteractionKind[]>(
    initialConfig?.kinds?.length ? initialConfig.kinds : [InteractionKind.MCQ],
  );
  const [strategy, setStrategy] = useState<GenerationStrategy>(
    initialConfig?.strategy ?? GenerationStrategy.AI_CHOOSE,
  );
  const [saving, startSave] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function toggleKind(kind: InteractionKind) {
    setKinds((prev) =>
      prev.includes(kind) ? prev.filter((k) => k !== kind) : [...prev, kind],
    );
  }

  function handleSave() {
    if (kinds.length === 0) {
      setError("Chọn ít nhất một loại bài tập.");
      return;
    }
    setError(null);
    startSave(async () => {
      try {
        const cfg = create(ChunkInteractionConfigSchema, { count, kinds, strategy });
        await aiClient.updateLessonDefaultInteractionConfig({
          lessonId,
          defaultInteractionConfig: cfg,
        });
        onSaved(cfg);
        onClose();
      } catch (err) {
        setError(err instanceof ConnectError ? err.message : "Không thể lưu cấu hình");
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Cấu hình mặc định cho cả lesson</DialogTitle>
          <p className="text-xs text-muted-foreground mt-0.5">
            Áp dụng cho các phân đoạn chưa có cấu hình riêng
          </p>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">Số lượng bài tập mặc định</label>
            <input
              type="number" min={1} max={8} value={count}
              onChange={(e) => setCount(Math.min(8, Math.max(1, parseInt(e.target.value) || 1)))}
              className="w-20 text-sm rounded border border-input bg-background px-2 py-1"
              disabled={saving}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">Loại bài tập mặc định</label>
            <div className="flex flex-col gap-1">
              {KIND_OPTIONS.map(({ kind, label }) => (
                <label key={kind} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={kinds.includes(kind)}
                    onChange={() => toggleKind(kind)}
                    disabled={saving}
                    className="rounded"
                  />
                  <span className="text-sm">{label}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">Cách phân bổ</label>
            <div className="flex flex-col gap-1">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio" name="strategy-default"
                  checked={strategy === GenerationStrategy.AI_CHOOSE}
                  onChange={() => setStrategy(GenerationStrategy.AI_CHOOSE)}
                  disabled={saving}
                />
                <span className="text-sm">AI chọn loại phù hợp nhất theo nội dung</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio" name="strategy-default"
                  checked={strategy === GenerationStrategy.EVEN_DISTRIBUTION}
                  onChange={() => setStrategy(GenerationStrategy.EVEN_DISTRIBUTION)}
                  disabled={saving}
                />
                <span className="text-sm">Phân bổ đều theo thứ tự đã chọn</span>
              </label>
            </div>
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={saving}>Hủy</Button>
          <Button size="sm" onClick={handleSave} disabled={saving} className="gap-1">
            {saving && <Loader2Icon className="size-3 animate-spin" />}
            Lưu
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
