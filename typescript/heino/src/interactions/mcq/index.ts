import { InteractionKind } from "buf/gen/richter/v1/interactions_pb";
import type { InteractionRenderer, McqConfig, McqResponse } from "../types";
import { McqStudentView } from "./mcq-student-view";
import { McqEditorView } from "./mcq-editor-view";
import { McqReviewRow } from "./mcq-review-row";

export const mcqRenderer: InteractionRenderer<McqConfig, McqResponse> = {
  kind: InteractionKind.MCQ,
  label: "Trắc nghiệm",
  StudentView: McqStudentView,
  EditorView: McqEditorView,
  ReviewRow: McqReviewRow,
  gradeLocal(cfg, resp) {
    const correct = cfg.correctAnswer >= 0 && resp.selected === cfg.correctAnswer ? 1 : 0;
    return { score: correct, maxScore: 1 };
  },
};
