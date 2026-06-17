"use client";

import { useState, useTransition } from "react";
import { ConnectError } from "@connectrpc/connect";
import { AIService, type TranscriptSegment } from "buf/gen/richter/v1/ai_pb";
import { CheckIcon, Loader2Icon, PencilIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useRichterWebClient } from "@/lib/connect-webclient";
import { formatTime } from "@/lib/format";

interface SegmentRowProps {
  segment: TranscriptSegment;
  index: number;
  lessonId: string;
  onUpdated: (index: number, text: string) => void;
  onSaved?: () => void;
  disabled: boolean;
  aiClient: ReturnType<typeof useRichterWebClient<typeof AIService>>;
}

export function SegmentRow({ segment, index, lessonId, onUpdated, onSaved, disabled, aiClient }: SegmentRowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(segment.text);
  const [saving, startSaving] = useTransition();
  const [saveError, setSaveError] = useState<string | null>(null);

  function handleSave() {
    if (draft.trim() === segment.text) { setEditing(false); return; }
    setSaveError(null);
    startSaving(async () => {
      try {
        await aiClient.updateTranscriptSegment({ lessonId, segmentIndex: index, text: draft.trim() });
        onUpdated(index, draft.trim());
        setEditing(false);
        onSaved?.();
      } catch (err) {
        setSaveError(err instanceof ConnectError ? err.message : "Không thể lưu - thử lại");
      }
    });
  }

  return (
    <div className="flex gap-2 items-start rounded-md border border-border bg-muted/30 px-2 py-1.5 text-xs">
      <span className="text-muted-foreground shrink-0 tabular-nums pt-0.5">
        {formatTime(segment.startSeconds)}
      </span>
      <div className="flex-1 min-w-0">
        {editing ? (
          <>
            <textarea
              autoFocus
              className="w-full resize-none rounded border border-input bg-background px-1.5 py-1 text-xs text-foreground focus:outline-none"
              rows={3}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") { setDraft(segment.text); setEditing(false); setSaveError(null); }
              }}
            />
            {saveError && <p className="text-xs text-destructive mt-0.5">{saveError}</p>}
          </>
        ) : (
          <p className="text-foreground leading-relaxed">{segment.text}</p>
        )}
      </div>
      {!disabled && (
        editing ? (
          <Button
            variant="ghost" size="icon" className="size-6 shrink-0"
            disabled={saving} onClick={handleSave} title="Lưu"
          >
            {saving ? <Loader2Icon className="size-3 animate-spin" /> : <CheckIcon className="size-3" />}
          </Button>
        ) : (
          <Button
            variant="ghost" size="icon" className="size-6 shrink-0"
            onClick={() => setEditing(true)} title="Chỉnh sửa"
          >
            <PencilIcon className="size-3" />
          </Button>
        )
      )}
    </div>
  );
}
