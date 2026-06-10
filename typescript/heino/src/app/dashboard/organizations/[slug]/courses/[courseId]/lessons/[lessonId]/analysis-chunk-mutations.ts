"use client";

import { useCallback, useState } from "react";
import { toast } from "sonner";
import { toUserMessage } from "@/lib/connect-error";
import type { TranscriptChunk } from "buf/gen/richter/v1/ai_pb";
import type { AIClient } from "./use-lesson-analysis-state";
import {
  adjustLessonChunkBoundaryAction,
  deleteLessonChunkAction,
  mergeLessonChunksAction,
  splitLessonChunkAction,
} from "./actions";

type MutatingOp = "merge" | "delete" | "split" | "move";

export interface UseAnalysisChunkMutationsInput {
  lessonId: string;
  aiClient: AIClient;
  chunks: TranscriptChunk[];
  setChunks: React.Dispatch<React.SetStateAction<TranscriptChunk[]>>;
}

export interface UseAnalysisChunkMutationsResult {
  mutatingChunkId: string | null;
  mutatingOp: MutatingOp | null;
  mutatingError: string | null;
  isReloadingChunks: boolean;
  setMutatingError: (e: string | null) => void;
  reloadChunks: () => Promise<void>;
  handleMergeWithPrev: (chunkId: string) => Promise<void>;
  handleMergeWithNext: (chunkId: string) => Promise<void>;
  handleDeleteChunk: (chunkId: string) => Promise<void>;
  handleSplitChunk: (chunkId: string, splitAtSeconds: number) => Promise<void>;
  handleMoveSegment: (prevChunkId: string, nextChunkId: string, newBoundarySeconds: number, triggerChunkId: string) => Promise<void>;
}

function errorMessage(err: unknown, fallback: string): string {
  return toUserMessage(err, fallback);
}

export function useAnalysisChunkMutations({
  lessonId,
  aiClient,
  chunks,
  setChunks,
}: UseAnalysisChunkMutationsInput): UseAnalysisChunkMutationsResult {
  const [mutatingChunkId, setMutatingChunkId] = useState<string | null>(null);
  const [mutatingOp, setMutatingOp] = useState<MutatingOp | null>(null);
  const [mutatingError, setMutatingError] = useState<string | null>(null);
  const [isReloadingChunks, setIsReloadingChunks] = useState(false);

  const reloadChunks = useCallback(async () => {
    setIsReloadingChunks(true);
    try {
      const res = await aiClient.listLessonTranscriptChunks({ lessonId, limit: 500, offset: 0 });
      setChunks(res.chunks);
    } finally {
      setIsReloadingChunks(false);
    }
  }, [aiClient, lessonId, setChunks]);

  const runMutation = useCallback(
    async (chunkId: string | null, op: MutatingOp | null, action: () => Promise<unknown>, fallbackError: string) => {
      setMutatingChunkId(chunkId);
      setMutatingOp(op);
      setMutatingError(null);
      try {
        await action();
        await reloadChunks();
      } catch (err) {
        const msg = errorMessage(err, fallbackError);
        setMutatingError(msg);
        toast.error(msg);
      } finally {
        setMutatingChunkId(null);
        setMutatingOp(null);
      }
    },
    [reloadChunks],
  );

  const handleMergeWithPrev = useCallback(
    (chunkId: string) => {
      const idx = chunks.findIndex((c) => c.id === chunkId);
      if (idx <= 0) return Promise.resolve();
      return runMutation(
        chunkId,
        "merge",
        () => mergeLessonChunksAction({ keepChunkId: chunks[idx - 1].id, discardChunkId: chunkId }),
        "Không thể gộp đoạn",
      );
    },
    [chunks, runMutation],
  );

  const handleMergeWithNext = useCallback(
    (chunkId: string) => {
      const idx = chunks.findIndex((c) => c.id === chunkId);
      if (idx < 0 || idx >= chunks.length - 1) return Promise.resolve();
      return runMutation(
        chunkId,
        "merge",
        () => mergeLessonChunksAction({ keepChunkId: chunkId, discardChunkId: chunks[idx + 1].id }),
        "Không thể gộp đoạn",
      );
    },
    [chunks, runMutation],
  );

  const handleDeleteChunk = useCallback(
    (chunkId: string) => runMutation(chunkId, "delete", () => deleteLessonChunkAction({ chunkId }), "Không thể xóa đoạn"),
    [runMutation],
  );

  const handleSplitChunk = useCallback(
    (chunkId: string, splitAtSeconds: number) =>
      runMutation(chunkId, "split", () => splitLessonChunkAction({ chunkId, splitAtSeconds }), "Không thể tách đoạn"),
    [runMutation],
  );

  const handleMoveSegment = useCallback(
    (prevChunkId: string, nextChunkId: string, newBoundarySeconds: number, triggerChunkId: string) =>
      runMutation(
        triggerChunkId,
        "move",
        () => adjustLessonChunkBoundaryAction({ prevChunkId, nextChunkId, newBoundarySeconds }),
        "Không thể di chuyển segment",
      ),
    [runMutation],
  );

  return {
    mutatingChunkId,
    mutatingOp,
    mutatingError,
    isReloadingChunks,
    setMutatingError,
    reloadChunks,
    handleMergeWithPrev,
    handleMergeWithNext,
    handleDeleteChunk,
    handleSplitChunk,
    handleMoveSegment,
  };
}
