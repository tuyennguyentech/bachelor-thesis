import { InteractionKind } from "buf/gen/richter/v1/interactions_pb";
import type { InteractionRenderer, McqConfig, McqResponse } from "../types";
import { McqStudentView } from "./mcq-student-view";
import { McqEditorView } from "./mcq-editor-view";
import { McqReviewRow } from "./mcq-review-row";

export const mcqRenderer: InteractionRenderer<McqConfig, McqResponse> = {
  kind: InteractionKind.SINGLE_CHOICE,
  label: "Trắc nghiệm một đáp án",
  StudentView: McqStudentView,
  EditorView: McqEditorView,
  ReviewRow: McqReviewRow,
  gradeLocal(cfg, resp) {
    const correct = cfg.correctAnswer >= 0 && resp.selected === cfg.correctAnswer ? 1 : 0;
    return { score: correct, maxScore: 1 };
  },
};

export const multipleChoiceRenderer: InteractionRenderer<McqConfig, McqResponse> = {
  kind: InteractionKind.MULTIPLE_CHOICE,
  label: "Trắc nghiệm nhiều đáp án",
  StudentView: McqStudentView,
  EditorView: McqEditorView,
  ReviewRow: McqReviewRow,
  gradeLocal(cfg, resp) {
    const correctAnswers = cfg.correctAnswers || [];
    const selectedIndexes = resp.selectedIndexes || [];
    if (correctAnswers.length === 0) return { score: 0, maxScore: 1 };

    const isCorrect = correctAnswers.length === selectedIndexes.length &&
      correctAnswers.every((a) => selectedIndexes.includes(a));

    return { score: isCorrect ? 1 : 0, maxScore: 1 };
  },
};
