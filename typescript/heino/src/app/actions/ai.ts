"use server";

import { requireAnyUser } from "@/lib/auth";
import { createRichterClient } from "@/lib/connect-client";
import { AIService } from "buf/gen/richter/v1/ai_pb";

export async function getLessonAnalysis(lessonId: string) {
  const { token } = await requireAnyUser();
  const client = createRichterClient(AIService, token);
  try {
    const res = await client.getLessonAnalysis({ lessonId });
    return { analysis: res.analysis ?? null, chunks: res.chunks };
  } catch {
    return { analysis: null, chunks: [] };
  }
}

export async function updateTranscriptSegment(lessonId: string, segmentIndex: number, text: string) {
  const { token } = await requireAnyUser();
  const client = createRichterClient(AIService, token);
  try {
    const res = await client.updateTranscriptSegment({ lessonId, segmentIndex, text });
    return { segment: res.segment ?? null, error: null };
  } catch (e) {
    return { segment: null, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function mergeChunks(keepChunkId: string, discardChunkId: string) {
  const { token } = await requireAnyUser();
  const client = createRichterClient(AIService, token);
  try {
    const res = await client.mergeChunks({ keepChunkId, discardChunkId });
    return { chunk: res.mergedChunk ?? null, error: null };
  } catch (e) {
    return { chunk: null, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function deleteChunk(chunkId: string) {
  const { token } = await requireAnyUser();
  const client = createRichterClient(AIService, token);
  try {
    await client.deleteChunk({ chunkId });
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export async function listLessonTranscriptChunks(lessonId: string) {
  const { token } = await requireAnyUser();
  const client = createRichterClient(AIService, token);
  try {
    const res = await client.listLessonTranscriptChunks({ lessonId });
    return res.chunks;
  } catch {
    return [];
  }
}

export async function updateChunkConfig(chunkId: string, questionCount: number) {
  const { token } = await requireAnyUser();
  const client = createRichterClient(AIService, token);
  try {
    const res = await client.updateChunkConfig({ chunkId, questionCount });
    return { chunk: res.chunk ?? null, error: null };
  } catch (e) {
    return { chunk: null, error: e instanceof Error ? e.message : String(e) };
  }
}

interface QuestionFields {
  questionText: string;
  options: string[];
  correctAnswer: number;
  explanation: string;
  startSeconds: number;
}

export async function updateLessonQuestion(questionId: string, fields: QuestionFields) {
  const { token } = await requireAnyUser();
  const client = createRichterClient(AIService, token);
  try {
    const res = await client.updateLessonQuestion({ questionId, ...fields });
    return { question: res.question ?? null, error: null };
  } catch (e) {
    return { question: null, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function createManualQuestion(lessonId: string, fields: QuestionFields) {
  const { token } = await requireAnyUser();
  const client = createRichterClient(AIService, token);
  try {
    const res = await client.createManualQuestion({ lessonId, ...fields });
    return { question: res.question ?? null, error: null };
  } catch (e) {
    return { question: null, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function deleteLessonQuestion(questionId: string) {
  const { token } = await requireAnyUser();
  const client = createRichterClient(AIService, token);
  try {
    await client.deleteLessonQuestion({ questionId });
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export async function regenerateQuestion(questionId: string) {
  const { token } = await requireAnyUser();
  const client = createRichterClient(AIService, token);
  try {
    const res = await client.regenerateQuestion({ questionId });
    return { question: res.question ?? null, error: null };
  } catch (e) {
    return { question: null, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function splitChunk(chunkId: string, splitAtSeconds: number) {
  const { token } = await requireAnyUser();
  const client = createRichterClient(AIService, token);
  try {
    const res = await client.splitChunk({ chunkId, splitAtSeconds });
    return { firstChunk: res.firstChunk ?? null, secondChunk: res.secondChunk ?? null, error: null };
  } catch (e) {
    return { firstChunk: null, secondChunk: null, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function adjustChunkBoundary(prevChunkId: string, nextChunkId: string, newBoundarySeconds: number) {
  const { token } = await requireAnyUser();
  const client = createRichterClient(AIService, token);
  try {
    const res = await client.adjustChunkBoundary({ prevChunkId, nextChunkId, newBoundarySeconds });
    return { prevChunk: res.prevChunk ?? null, nextChunk: res.nextChunk ?? null, error: null };
  } catch (e) {
    return { prevChunk: null, nextChunk: null, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function updateWatchProgress(lessonId: string, positionSeconds: number) {
  const { token } = await requireAnyUser();
  const client = createRichterClient(AIService, token);
  try {
    await client.updateWatchProgress({ lessonId, positionSeconds });
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export async function getWatchProgress(lessonId: string): Promise<number> {
  const { token } = await requireAnyUser();
  const client = createRichterClient(AIService, token);
  try {
    const res = await client.getWatchProgress({ lessonId });
    return res.positionSeconds ?? 0;
  } catch {
    return 0;
  }
}
