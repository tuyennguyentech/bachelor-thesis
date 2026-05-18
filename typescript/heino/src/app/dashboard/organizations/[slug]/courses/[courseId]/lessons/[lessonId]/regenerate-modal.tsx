"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Loader2Icon, RefreshCwIcon } from "lucide-react";
import type { LessonInteraction } from "buf/gen/richter/v1/interactions_pb";
import { InteractionKind, InteractionService } from "buf/gen/richter/v1/interactions_pb";
import { useRichterWebClient } from "@/lib/connect-webclient";
import { ConnectError } from "@connectrpc/connect";

function formatTime(s: number) {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

const KIND_OPTIONS = [
  { kind: InteractionKind.MCQ, label: "Trắc nghiệm" },
  { kind: InteractionKind.FILL_BLANK, label: "Điền đáp án" },
  { kind: InteractionKind.READING, label: "Bài đọc" },
  { kind: InteractionKind.LISTENING, label: "Bài nghe" },
];

const KIND_LABELS: Partial<Record<InteractionKind, string>> = Object.fromEntries(
  KIND_OPTIONS.map(({ kind, label }) => [kind, label]),
);

interface Props {
  open: boolean;
  onClose: () => void;
  interaction: LessonInteraction;
  token: string;
  onRegenerated: (updated: LessonInteraction) => void;
}

export function RegenerateModal({ open, onClose, interaction, token, onRegenerated }: Props) {
  const interactionClient = useRichterWebClient(InteractionService, token);
  const [changeKind, setChangeKind] = useState(false);
  const [newKind, setNewKind] = useState<InteractionKind>(interaction.kind);
  const [saving, startSave] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleRegenerate() {
    setError(null);
    startSave(async () => {
      try {
        const res = await interactionClient.regenerateInteraction({
          interactionId: interaction.id,
          newKind: changeKind ? newKind : 0,
        });
        if (res.interaction) {
          onRegenerated(res.interaction);
          onClose();
        }
      } catch (err) {
        setError(err instanceof ConnectError ? err.message : "Không thể tạo lại bài tập");
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Tạo lại bài tập?</DialogTitle>
          <p className="text-xs text-muted-foreground mt-0.5">
            Loại hiện tại: {KIND_LABELS[interaction.kind] ?? "Không xác định"} · {formatTime(interaction.startSeconds)}
          </p>
        </DialogHeader>

        <div className="flex flex-col gap-3 py-2">
          <p className="text-xs text-muted-foreground">
            AI sẽ tạo bài tập mới thay thế bài tập hiện tại (không thể hoàn tác).
          </p>

          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={changeKind}
              onChange={(e) => setChangeKind(e.target.checked)}
              disabled={saving}
              className="rounded"
            />
            <span className="text-sm">Đổi sang loại khác</span>
          </label>

          {changeKind && (
            <div className="ml-5">
              <select
                value={newKind}
                onChange={(e) => setNewKind(Number(e.target.value) as InteractionKind)}
                disabled={saving}
                className="text-sm rounded border border-input bg-background px-2 py-1"
              >
                {KIND_OPTIONS.map(({ kind, label }) => (
                  <option key={kind} value={kind}>{label}</option>
                ))}
              </select>
            </div>
          )}

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={saving}>Hủy</Button>
          <Button size="sm" onClick={handleRegenerate} disabled={saving} className="gap-1">
            {saving
              ? <Loader2Icon className="size-3.5 animate-spin" />
              : <RefreshCwIcon className="size-3.5" />}
            Tạo lại
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
