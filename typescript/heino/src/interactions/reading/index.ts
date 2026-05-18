import { InteractionKind } from "buf/gen/richter/v1/interactions_pb";
import type { InteractionRenderer, ReadingConfig, ReadingResponse } from "../types";
import { ReadingStudentView } from "./reading-student-view";
import { ReadingEditorView } from "./reading-editor-view";
import { ReadingReviewRow } from "./reading-review-row";

export const readingRenderer: InteractionRenderer<ReadingConfig, ReadingResponse> = {
  kind: InteractionKind.READING,
  label: "Bài đọc",
  StudentView: ReadingStudentView,
  EditorView: ReadingEditorView,
  ReviewRow: ReadingReviewRow,
};
