"use server";

import { Code, ConnectError } from "@connectrpc/connect";
import { FeedbackMode } from "buf/gen/richter/v1/interactions_pb";
import { AIService } from "buf/gen/richter/v1/ai_pb";
import { LessonService } from "buf/gen/richter/v1/courses_pb";
import { createRichterClient } from "@/lib/connect-client";
import { getSession } from "@/lib/auth";
import { toUserMessage } from "@/lib/connect-error";

export type ActionResult<T = void> = { ok: true; data: T } | { ok: false; error: string };

async function withLessonClient<T>(fn: (client: ReturnType<typeof createRichterClient<typeof LessonService>>) => Promise<T>): Promise<ActionResult<T>> {
  const session = await getSession();
  if (!session) return { ok: false, error: "Phiên đăng nhập đã hết hạn" };
  try {
    const client = createRichterClient(LessonService, session.token);
    const data = await fn(client);
    return { ok: true, data };
  } catch (err) {
    if (err instanceof ConnectError && err.code === Code.Unauthenticated) {
      return { ok: false, error: "Phiên đăng nhập đã hết hạn" };
    }
    return { ok: false, error: toUserMessage(err, "Không thể cập nhật bài học") };
  }
}

async function withAIClient<T>(fn: (client: ReturnType<typeof createRichterClient<typeof AIService>>) => Promise<T>): Promise<ActionResult<T>> {
  const session = await getSession();
  if (!session) return { ok: false, error: "Phiên đăng nhập đã hết hạn" };
  try {
    const client = createRichterClient(AIService, session.token);
    const data = await fn(client);
    return { ok: true, data };
  } catch (err) {
    if (err instanceof ConnectError && err.code === Code.Unauthenticated) {
      return { ok: false, error: "Phiên đăng nhập đã hết hạn" };
    }
    return { ok: false, error: toUserMessage(err, "Không thể thao tác với máy chủ") };
  }
}

export async function updateLessonLanguageAction({
  lessonId,
  title,
  description,
  orderIndex,
  language,
  maxAttempts,
  audioLanguage,
}: {
  lessonId: string;
  title: string;
  description: string;
  orderIndex: number;
  language: string;
  maxAttempts: number;
  // Spoken/audio language of the video. Omitted ("") => the backend keeps the
  // existing value, so saving the OUTPUT language never clears the audio one.
  audioLanguage?: string;
}): Promise<ActionResult> {
  return withLessonClient(async (client) => {
    await client.updateLesson({ id: lessonId, title, description, orderIndex, language, maxAttempts, audioLanguage: audioLanguage ?? "" });
  });
}

export async function updateLessonMaxAttemptsAction({
  lessonId,
  title,
  description,
  orderIndex,
  language,
  maxAttempts,
}: {
  lessonId: string;
  title: string;
  description: string;
  orderIndex: number;
  language: string;
  maxAttempts: number;
}): Promise<ActionResult> {
  return withLessonClient(async (client) => {
    await client.updateLesson({ id: lessonId, title, description, orderIndex, language, maxAttempts });
  });
}

export async function updateLessonFeedbackModeAction({
  lessonId,
  feedbackMode,
}: {
  lessonId: string;
  feedbackMode: FeedbackMode;
}): Promise<ActionResult> {
  return withLessonClient(async (client) => {
    await client.updateLessonFeedbackMode({ id: lessonId, feedbackMode });
  });
}

export async function mergeLessonChunksAction({
  keepChunkId,
  discardChunkId,
}: {
  keepChunkId: string;
  discardChunkId: string;
}): Promise<ActionResult> {
  return withAIClient(async (client) => {
    await client.mergeChunks({ keepChunkId, discardChunkId });
  });
}

export async function deleteLessonChunkAction({ chunkId }: { chunkId: string }): Promise<ActionResult> {
  return withAIClient(async (client) => {
    await client.deleteChunk({ chunkId });
  });
}

export async function splitLessonChunkAction({
  chunkId,
  splitAtSeconds,
}: {
  chunkId: string;
  splitAtSeconds: number;
}): Promise<ActionResult> {
  return withAIClient(async (client) => {
    await client.splitChunk({ chunkId, splitAtSeconds });
  });
}

export async function adjustLessonChunkBoundaryAction({
  prevChunkId,
  nextChunkId,
  newBoundarySeconds,
}: {
  prevChunkId: string;
  nextChunkId: string;
  newBoundarySeconds: number;
}): Promise<ActionResult> {
  return withAIClient(async (client) => {
    await client.adjustChunkBoundary({ prevChunkId, nextChunkId, newBoundarySeconds });
  });
}

