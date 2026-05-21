import type { FC } from "react";
export { FeedbackMode, InteractionKind } from "buf/gen/richter/v1/interactions_pb";
import type { FeedbackMode, InteractionKind } from "buf/gen/richter/v1/interactions_pb";

export interface McqOption {
  text: string;
}

export interface McqConfig {
  options: McqOption[];
  correctAnswer: number; // -1 if hidden/not revealed by server
}

export interface McqResponse {
  selected: number; // -1 if unanswered
}

export interface Blank {
  accepted: string[];
  caseSensitive: boolean;
  hint: string;
}

export interface FillBlankConfig {
  template: string; // text with {{0}}, {{1}}, ... placeholders
  blanks: Blank[];
}

export interface FillBlankResponse {
  answers: string[];
}

export interface ListeningConfig {
  audioObjectKey: string;
  durationSeconds: number;
  mode: "dictation" | "comprehension";
  expectedText: string;
  comprehensionQuestions: McqConfig[];
}

export interface ListeningResponse {
  transcription: string;
  comprehensionAnswers: number[];
}

export interface ReadingConfig {
  mode: "pronunciation" | "open_answer";
  passageMarkdown: string;
  /** OPEN_ANSWER only: question the student must answer verbally */
  question?: string;
}

export interface ReadingResponse {
  audioObjectKey: string;
}

export interface StudentViewProps<Config, Response> {
  config: Config;
  explanation?: string;
  initialResponse: Response | null;
  feedbackMode: FeedbackMode;
  locked: boolean;
  onAnswer: (r: Response) => void;
  onContinue: () => void;
  /** Optional: auth token — used by renderers that call backend APIs (e.g. audio presign) */
  token?: string;
  /** Optional: lesson UUID — used by renderers that upload student recordings */
  lessonId?: string;
}

export interface EditorViewProps<Config> {
  config: Config;
  onChange: (c: Config) => void;
  /** Optional: lesson UUID — used by renderers that upload assets */
  lessonId?: string;
  /** Optional: auth token — used by renderers that upload assets */
  token?: string;
}

export interface ReviewRowProps<Config, Response> {
  index: number;
  prompt: string;
  explanation: string;
  config: Config;
  response: Response | undefined;
  score: number;
  /** Server-generated feedback text (e.g. AI grading remarks for reading). Empty for kinds without AI grading. */
  feedback?: string;
  feedbackMode: FeedbackMode;
  /** Optional: auth token — used by review rows that fetch presigned URLs (e.g. reading audio) */
  token?: string;
}

export interface InteractionRenderer<Config, Response> {
  kind: InteractionKind;
  label: string;
  StudentView: FC<StudentViewProps<Config, Response>>;
  EditorView: FC<EditorViewProps<Config>>;
  ReviewRow: FC<ReviewRowProps<Config, Response>>;
  gradeLocal?: (cfg: Config, resp: Response) => { score: number; maxScore: number };
}
