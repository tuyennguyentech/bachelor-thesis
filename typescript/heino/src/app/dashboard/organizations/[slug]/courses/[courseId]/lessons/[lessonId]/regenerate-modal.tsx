"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Loader2Icon, SparklesIcon } from "lucide-react";
import type { LessonInteraction } from "buf/gen/richter/v1/interactions_pb";
import { InteractionService } from "buf/gen/richter/v1/interactions_pb";
import { useRichterWebClient } from "@/lib/connect-webclient";
import { ConnectError } from "@connectrpc/connect";

function formatTime(s: number) {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

interface Props {
  open: boolean;
  onClose: () => void;
  interaction: LessonInteraction;
  token: string;
  onRegenerated: (updated: LessonInteraction) => void;
}

export function RegenerateModal({ open, onClose, interaction, token, onRegenerated }: Props) {
  const interactionClient = useRichterWebClient(InteractionService, token);

  const [customPrompt, setCustomPrompt] = useState("");
  const [saving, startSave] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const presets = [
    { label: "Đơn giản hóa", icon: "✨", prompt: "Hãy làm cho câu hỏi và đáp án dễ hiểu hơn, sử dụng từ vựng đơn giản, phù hợp cho người mới bắt đầu." },
    { label: "Tăng độ khó", icon: "🔥", prompt: "Hãy tăng độ khó của câu hỏi này, thêm các lựa chọn đáp án gây nhiễu tinh tế, đòi hỏi tư duy phân tích sâu hơn." },
    { label: "Dịch sang tiếng Anh", icon: "🌍", prompt: "Hãy dịch toàn bộ nội dung câu hỏi, các đáp án lựa chọn và giải thích sang tiếng Anh chuẩn tự nhiên." },
    { label: "Thêm giải thích", icon: "📖", prompt: "Hãy giữ nguyên câu hỏi và đáp án, nhưng viết lại phần giải thích đáp án (explanation) cực kỳ chi tiết, khoa học và dễ hiểu." }
  ];

  function handleRegenerate() {
    setError(null);
    startSave(async () => {
      try {
        const res = await interactionClient.regenerateInteraction({
          interactionId: interaction.id,
          newKind: 0,
          customPrompt: customPrompt.trim(),
        });
        if (res.interaction) {
          onRegenerated(res.interaction);
          onClose();
        }
      } catch (err) {
        setError(err instanceof ConnectError ? err.message : "Không thể chỉnh sửa câu hỏi");
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md rounded-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg">
            <div className="rounded-lg bg-primary/10 p-2">
              <SparklesIcon className="size-5 text-primary" />
            </div>
            Chỉnh sửa bằng AI
          </DialogTitle>
          <div className="flex items-center gap-2 text-xs text-muted-foreground mt-1">
            <span className="font-mono bg-muted rounded-md px-2 py-1">{formatTime(interaction.startSeconds)}</span>
          </div>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          {/* Preset quick actions */}
          <div className="flex flex-col gap-2.5">
            <p className="text-sm font-medium">Chỉnh sửa nhanh</p>
            <div className="grid grid-cols-2 gap-2">
              {presets.map((preset, idx) => (
                <button
                  key={idx}
                  type="button"
                  disabled={saving}
                  onClick={() => setCustomPrompt(preset.prompt)}
                  className={`flex items-center gap-2 text-sm px-3 py-2.5 rounded-xl border-2 text-left font-medium transition-all ${
                    customPrompt === preset.prompt
                      ? "border-primary bg-primary/10 text-primary shadow-sm"
                      : "border-transparent bg-muted/30 text-muted-foreground hover:bg-muted/50"
                  }`}
                >
                  <span>{preset.icon}</span>
                  <span>{preset.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Custom prompt */}
          <div className="flex flex-col gap-2.5">
            <label htmlFor="ai-magic-prompt" className="text-sm font-medium">
              Hoặc nhập chỉ dẫn riêng
            </label>
            <textarea
              id="ai-magic-prompt"
              value={customPrompt}
              onChange={(e) => setCustomPrompt(e.target.value)}
              placeholder="Ví dụ: Đổi câu hỏi này sang chủ đề bóng đá; Làm cho các lựa chọn đáp án ngắn gọn hơn..."
              rows={3}
              disabled={saving}
              className="w-full text-sm rounded-xl border border-input bg-background px-3 py-2.5 text-foreground placeholder:text-muted-foreground focus:ring-2 focus:ring-primary focus:outline-none transition-all resize-none"
            />
          </div>

          {error && (
            <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3">
              <p className="text-sm text-destructive">{error}</p>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={onClose} disabled={saving} className="rounded-xl">
            Hủy
          </Button>
          <Button
            onClick={handleRegenerate}
            disabled={saving}
            className="gap-2 rounded-xl px-6"
          >
            {saving ? (
              <>
                <Loader2Icon className="size-4 animate-spin" />
                Đang xử lý...
              </>
            ) : (
              <>
                <SparklesIcon className="size-4" />
                Áp dụng
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
