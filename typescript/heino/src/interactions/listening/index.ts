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
    // A listening exercise is one (or more) MCQ(s) whose question is the audio.
    const total = cfg.comprehensionQuestions.length;
    const score = cfg.comprehensionQuestions.reduce((acc, q, idx) => {
      return acc + ((resp.comprehensionAnswers[idx] ?? -1) === q.correctAnswer ? 1 : 0);
    }, 0);
    return { score, maxScore: total || 1 };
  },
};
