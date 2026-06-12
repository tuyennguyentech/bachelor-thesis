import { InteractionKind } from "buf/gen/richter/v1/interactions_pb";
import type { InteractionRenderer, WritingConfig, WritingResponse } from "../types";
import { WritingStudentView } from "./writing-student-view";
import { WritingEditorView } from "./writing-editor-view";
import { WritingReviewRow } from "./writing-review-row";

export const writingRenderer: InteractionRenderer<WritingConfig, WritingResponse> = {
  kind: InteractionKind.WRITING,
  label: "Bài viết",
  StudentView: WritingStudentView,
  EditorView: WritingEditorView,
  ReviewRow: WritingReviewRow,
  // No gradeLocal — writing is graded by the AI server-side.
};
