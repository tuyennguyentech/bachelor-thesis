"use client";

import { AnalysisStatus } from "buf/gen/richter/v1/ai_pb";
import type { WorkflowContentStepKey } from "./analysis-workflow-ui";
import { getInitialWorkflowStep } from "./analysis-workflow-ui";

export type StepperState = { activeStep: WorkflowContentStepKey };

export type StepperAction =
  | { type: "SET_STEP"; step: WorkflowContentStepKey }
  | { type: "RESET"; hasVideo: boolean; hasSegments: boolean; hasChunks: boolean; hasInteractions: boolean; hasTranscript: boolean }
  | { type: "ADVANCE_AFTER_EXTRACT"; hasChunks: boolean }
  | { type: "ADVANCE_AFTER_CHUNK" }
  | { type: "ADVANCE_AFTER_GENERATE" };

export function stepperReducer(state: StepperState, action: StepperAction): StepperState {
  switch (action.type) {
    case "SET_STEP":
      return { activeStep: action.step };
    case "RESET": {
      const step = getInitialWorkflowStep(
        action.hasVideo,
        [],
        [],
        [],
        action.hasTranscript ? "" : "",
        action.hasTranscript ? AnalysisStatus.TRANSCRIPT_EXTRACTED : undefined,
      );
      return { activeStep: action.hasVideo ? step : "upload" };
    }
    case "ADVANCE_AFTER_EXTRACT":
      return { activeStep: action.hasChunks ? "exercises" : "chunks" };
    case "ADVANCE_AFTER_CHUNK":
      return { activeStep: "exercises" };
    case "ADVANCE_AFTER_GENERATE":
      return { activeStep: "exercises" };
    default: {
      const _exhaustive: never = action;
      void _exhaustive;
      return state;
    }
  }
}
