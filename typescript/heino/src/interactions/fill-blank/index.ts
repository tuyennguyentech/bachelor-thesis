import { InteractionKind } from "buf/gen/richter/v1/interactions_pb";
import type { InteractionRenderer, FillBlankConfig, FillBlankResponse } from "../types";
import { FillBlankStudentView } from "./fill-blank-student-view";
import { FillBlankEditorView } from "./fill-blank-editor-view";
import { FillBlankReviewRow } from "./fill-blank-review-row";

export const fillBlankRenderer: InteractionRenderer<FillBlankConfig, FillBlankResponse> = {
  kind: InteractionKind.FILL_BLANK,
  label: "Điền đáp án",
  StudentView: FillBlankStudentView,
  EditorView: FillBlankEditorView,
  ReviewRow: FillBlankReviewRow,
  gradeLocal(cfg, resp) {
    let correct = 0;
    cfg.blanks.forEach((b, i) => {
      const got = resp.answers[i] ?? "";
      const match = b.accepted.some((want) =>
        b.caseSensitive ? got === want : got.trim().toLowerCase() === want.trim().toLowerCase()
      );
      if (match) correct++;
    });
    return { score: correct, maxScore: cfg.blanks.length };
  },
};
