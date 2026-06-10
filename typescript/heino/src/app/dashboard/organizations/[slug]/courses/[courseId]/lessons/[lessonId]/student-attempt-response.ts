import { InteractionKind } from "buf/gen/richter/v1/interactions_pb";
import type { LessonInteraction } from "buf/gen/richter/v1/interactions_pb";
import type { FillBlankResponse, ListeningResponse, McqResponse, ReadingResponse } from "@/interactions/types";

export function buildAttemptResponseInput(it: LessonInteraction, localResp: unknown) {
  if (it.kind === InteractionKind.MULTIPLE_CHOICE) {
    return {
      interactionId: it.id,
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
        response: {
          case: "fillBlank" as const,
          value: { answers: (localResp as FillBlankResponse | undefined)?.answers ?? [] },
        },
      };
    case "reading":
      return {
        interactionId: it.id,
        response: {
          case: "reading" as const,
          value: { audioObjectKey: (localResp as ReadingResponse | undefined)?.audioObjectKey ?? "" },
        },
      };
    case "listening": {
      const r = localResp as ListeningResponse | undefined;
      return {
        interactionId: it.id,
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
        response: {
          case: "mcqSelected" as const,
          value: (localResp as McqResponse | undefined)?.selected ?? 0,
        },
      };
  }
}
