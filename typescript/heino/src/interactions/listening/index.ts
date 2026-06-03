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
  gradeLocal(cfg, resp) {
    if (cfg.mode === "comprehension") {
      const total = cfg.comprehensionQuestions.length;
      const score = cfg.comprehensionQuestions.reduce((acc, q, idx) => {
        return acc + ((resp.comprehensionAnswers[idx] ?? -1) === q.correctAnswer ? 1 : 0);
      }, 0);
      return { score, maxScore: total || 1 };
    }

    const normalize = (s: string) =>
      s
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim();
    const got = new Set(normalize(resp.transcription).split(/\s+/).filter(Boolean));
    const want = new Set(normalize(cfg.expectedText).split(/\s+/).filter(Boolean));
    if (got.size === 0 && want.size === 0) return { score: 1, maxScore: 1 };
    let intersection = 0;
    for (const word of got) if (want.has(word)) intersection += 1;
    const union = got.size + want.size - intersection;
    return { score: union > 0 ? intersection / union : 0, maxScore: 1 };
  },
};
