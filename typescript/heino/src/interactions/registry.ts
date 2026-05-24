import { InteractionKind, ListeningMode, ReadingMode } from "buf/gen/richter/v1/interactions_pb";
import type { LessonInteraction, LessonAttemptResponse } from "buf/gen/richter/v1/interactions_pb";
import type {
  InteractionRenderer,
  McqConfig, McqResponse,
  FillBlankConfig, FillBlankResponse,
  ListeningConfig, ListeningResponse,
  ReadingConfig, ReadingResponse,
} from "./types";
import { mcqRenderer } from "./mcq";
import { fillBlankRenderer } from "./fill-blank";
import { listeningRenderer } from "./listening";
import { readingRenderer } from "./reading";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const registry: Record<number, InteractionRenderer<any, any>> = {
  [InteractionKind.MCQ]: mcqRenderer,
  [InteractionKind.FILL_BLANK]: fillBlankRenderer,
  [InteractionKind.LISTENING]: listeningRenderer,
  [InteractionKind.READING]: readingRenderer,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getRenderer(kind: InteractionKind): InteractionRenderer<any, any> {
  const r = registry[kind];
  if (!r) throw new Error(`No renderer registered for InteractionKind ${kind}`);
  return r;
}

export const interactionRegistry = registry;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function extractConfig(interaction: LessonInteraction): any | null {
  if (interaction.config.case === "mcq") {
    const v = interaction.config.value;
    return {
      options: v.options.map((o) => ({ text: o.text })),
      correctAnswer: v.correctAnswer,
    } satisfies McqConfig;
  }
  if (interaction.config.case === "fillBlank") {
    const v = interaction.config.value;
    return {
      template: v.template,
      blanks: v.blanks.map((b) => ({
        accepted: [...b.accepted],
        caseSensitive: b.caseSensitive,
        hint: b.hint,
      })),
    } satisfies FillBlankConfig;
  }
  if (interaction.config.case === "listening") {
    const v = interaction.config.value;
    return {
      audioObjectKey: v.audioObjectKey,
      durationSeconds: v.durationSeconds,
      mode: v.mode === ListeningMode.DICTATION ? "dictation" : "comprehension",
      expectedText: v.expectedText,
      comprehensionQuestions: v.comprehensionQuestions.map((q) => ({
        options: q.options.map((o) => ({ text: o.text })),
        correctAnswer: q.correctAnswer,
      })),
    } satisfies ListeningConfig;
  }
  if (interaction.config.case === "reading") {
    const v = interaction.config.value;
    return {
      mode: v.mode === ReadingMode.OPEN_ANSWER ? "open_answer" : "pronunciation",
      passageMarkdown: v.passageMarkdown,
      question: v.question,
      expectedAnswer: v.expectedAnswer,
    } satisfies ReadingConfig;
  }
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function extractLocalResponse(protoResp: LessonAttemptResponse): any | null {
  if (protoResp.response.case === "mcqSelected") {
    return { selected: protoResp.response.value } satisfies McqResponse;
  }
  if (protoResp.response.case === "fillBlank") {
    return { answers: [...protoResp.response.value.answers] } satisfies FillBlankResponse;
  }
  if (protoResp.response.case === "listening") {
    const v = protoResp.response.value;
    return {
      transcription: v.transcription,
      comprehensionAnswers: [...v.comprehensionAnswers],
    } satisfies ListeningResponse;
  }
  if (protoResp.response.case === "reading") {
    return { audioObjectKey: protoResp.response.value.audioObjectKey } satisfies ReadingResponse;
  }
  return null;
}
