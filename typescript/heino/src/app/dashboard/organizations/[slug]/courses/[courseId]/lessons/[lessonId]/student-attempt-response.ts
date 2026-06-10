import { InteractionKind } from "buf/gen/richter/v1/interactions_pb";
import type { LessonInteraction } from "buf/gen/richter/v1/interactions_pb";
import type { FillBlankResponse, ListeningResponse, McqResponse, ReadingResponse } from "@/interactions/types";

export interface ResponseMetrics {
  timeToAnswerMs?: number;
  replayCount?: number;
}

export function buildAttemptResponseInput(it: LessonInteraction, localResp: unknown, metrics?: ResponseMetrics) {
  const timeToAnswerMs = metrics?.timeToAnswerMs ?? 0;
  const replayCount = metrics?.replayCount ?? 0;

  if (it.kind === InteractionKind.MULTIPLE_CHOICE) {
    return {
      interactionId: it.id,
      timeToAnswerMs,
      replayCount,
      response: {
        case: "mcqMultiple" as const,
        value: { selectedIndexes: (localResp as McqResponse | undefined)?.selectedIndexes ?? [] },
      },
    };
  }
  switch (it.config.case) {
    case "fillBlank":
      return {
        interactionId: it.id,
        timeToAnswerMs,
        replayCount,
        response: {
          case: "fillBlank" as const,
          value: { answers: (localResp as FillBlankResponse | undefined)?.answers ?? [] },
        },
      };
    case "reading":
      return {
        interactionId: it.id,
        timeToAnswerMs,
        replayCount,
        response: {
          case: "reading" as const,
          value: { audioObjectKey: (localResp as ReadingResponse | undefined)?.audioObjectKey ?? "" },
        },
      };
    case "listening": {
      const r = localResp as ListeningResponse | undefined;
      return {
        interactionId: it.id,
        timeToAnswerMs,
        replayCount,
        response: {
          case: "listening" as const,
          value: {
            transcription: r?.transcription ?? "",
            comprehensionAnswers: r?.comprehensionAnswers ?? [],
          },
        },
      };
    }
    default:
      return {
        interactionId: it.id,
        timeToAnswerMs,
        replayCount,
        response: {
          case: "mcqSelected" as const,
          value: (localResp as McqResponse | undefined)?.selected ?? 0,
        },
      };
  }
}
