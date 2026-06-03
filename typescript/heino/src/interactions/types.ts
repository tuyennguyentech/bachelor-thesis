import type { FC } from "react";
export { FeedbackMode, InteractionKind } from "buf/gen/richter/v1/interactions_pb";
import type { FeedbackMode, InteractionKind } from "buf/gen/richter/v1/interactions_pb";

export interface McqOption {
  text: string;
}

export interface McqConfig {
  question?: string; // used for nested MCQs, e.g. listening comprehension
  options: McqOption[];
  correctAnswer: number; // -1 if hidden/not revealed by server
  correctAnswers?: number[]; // used for MULTIPLE_CHOICE
}

export interface McqResponse {
  selected: number; // -1 if unanswered (used for SINGLE_CHOICE)
  selectedIndexes?: number[]; // used for MULTIPLE_CHOICE
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
  /** OPEN_ANSWER only: gold answer used for grading and revealed to student after submit */
  expectedAnswer?: string;
}

export interface ReadingResponse {
  audioObjectKey: string;
}

export interface InteractionGrade {
  score: number;
  maxScore: number;
  feedback?: string;
}

export interface StudentViewProps<Config, Response> {
  config: Config;
  explanation?: string;
  initialResponse: Response | null;
  feedbackMode: FeedbackMode;
  locked: boolean;
  onAnswer: (r: Response) => void;
  onContinue: () => void;
  /** True when there is another interaction queued at the same/earlier timestamp.
   * Used by views to label the continue button "Câu tiếp theo" instead of "Tiếp tục xem". */
  hasNextInCheckpoint?: boolean;
  /** Optional: auth token — used by renderers that call backend APIs (e.g. audio presign) */
  token?: string;
  /** Optional: lesson UUID — used by renderers that upload student recordings */
  lessonId?: string;
  /** Optional: interaction UUID — used by renderers that need to call back to the server
   * for this specific interaction (e.g. reading AFTER_EACH inline grading). */
  interactionId?: string;
  /** Optional: true when the teacher is previewing the lesson. Renderers that would
   * otherwise burn AI quota (e.g. reading PreviewGrade) should skip server calls. */
  isPreview?: boolean;
  /** Optional: the InteractionKind of this interaction, useful for components shared across multiple kinds */
  kind?: InteractionKind;
  /** Optional: report a server-side or async grade back to the parent view. */
  onGrade?: (grade: InteractionGrade) => void;
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
