import { InteractionKind } from "buf/gen/richter/v1/interactions_pb";
import type { InteractionRenderer, ListeningConfig, ListeningResponse } from "../types";
import { ListeningStudentView } from "./listening-student-view";
import { ListeningEditorView } from "./listening-editor-view";
import { ListeningReviewRow } from "./listening-review-row";

export const listeningRenderer: InteractionRenderer<ListeningConfig, ListeningResponse> = {
  kind: InteractionKind.LISTENING,
  label: "Bài nghe",
  StudentView: ListeningStudentView,
  EditorView: ListeningEditorView,
  ReviewRow: ListeningReviewRow,
};
