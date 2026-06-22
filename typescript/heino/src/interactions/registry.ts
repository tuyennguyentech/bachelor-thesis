import { InteractionKind, ReadingMode } from "buf/gen/richter/v1/interactions_pb";
import type { LessonInteraction, LessonAttemptResponse } from "buf/gen/richter/v1/interactions_pb";
import type {
  InteractionRenderer,
  McqConfig, McqResponse,
  FillBlankConfig, FillBlankResponse,
  ListeningConfig, ListeningResponse,
  ReadingConfig, ReadingResponse,
  WritingConfig, WritingResponse,
} from "./types";
import { mcqRenderer, multipleChoiceRenderer } from "./mcq";
import { fillBlankRenderer } from "./fill-blank";
import { listeningRenderer } from "./listening";
import { readingRenderer } from "./reading";
import { writingRenderer } from "./writing";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const registry: Record<number, InteractionRenderer<any, any>> = {
  [InteractionKind.SINGLE_CHOICE]: mcqRenderer,
  [InteractionKind.MULTIPLE_CHOICE]: multipleChoiceRenderer,
  [InteractionKind.FILL_BLANK]: fillBlankRenderer,
  [InteractionKind.LISTENING]: listeningRenderer,
  [InteractionKind.READING]: readingRenderer,
  [InteractionKind.WRITING]: writingRenderer,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getRenderer(kind: InteractionKind): InteractionRenderer<any, any> {
  const r = registry[kind];
  if (!r) throw new Error(`No renderer registered for InteractionKind ${kind}`);
  return r;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function extractConfig(interaction: LessonInteraction): any | null {
  if (interaction.config.case === "mcq") {
    const v = interaction.config.value;
    return {
      question: v.question,
      options: v.options.map((o) => ({ text: o.text })),
      correctAnswer: v.correctAnswer,
      correctAnswers: v.correctAnswers.length > 0 ? [...v.correctAnswers] : undefined,
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
      audioSourceText: v.audioSourceText,
      comprehensionQuestions: v.comprehensionQuestions.map((q) => ({
        question: q.question,
        options: q.options.map((o) => ({ text: o.text })),
        correctAnswer: q.correctAnswer,
        correctAnswers: q.correctAnswers.length > 0 ? [...q.correctAnswers] : undefined,
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
  if (interaction.config.case === "writing") {
    const v = interaction.config.value;
    return {
      prompt: v.prompt,
      rubric: v.rubric,
      expectedAnswer: v.expectedAnswer,
      minWords: v.minWords,
    } satisfies WritingConfig;
  }
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function extractLocalResponse(protoResp: LessonAttemptResponse): any | null {
  if (protoResp.response.case === "mcqSelected") {
    return { selected: protoResp.response.value } satisfies McqResponse;
  }
  if (protoResp.response.case === "mcqMultiple") {
    const v = protoResp.response.value;
    return {
      selected: -1,
      selectedIndexes: v.selectedIndexes ? [...v.selectedIndexes] : [],
    } satisfies McqResponse;
  }
  if (protoResp.response.case === "fillBlank") {
    return { answers: [...protoResp.response.value.answers] } satisfies FillBlankResponse;
  }
  if (protoResp.response.case === "listening") {
    const v = protoResp.response.value;
    return {
      comprehensionAnswers: [...v.comprehensionAnswers],
    } satisfies ListeningResponse;
  }
  if (protoResp.response.case === "reading") {
    return { audioObjectKey: protoResp.response.value.audioObjectKey } satisfies ReadingResponse;
  }
  if (protoResp.response.case === "writing") {
    return { text: protoResp.response.value.text } satisfies WritingResponse;
  }
  return null;
}
