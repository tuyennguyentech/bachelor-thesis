"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { FeedbackMode } from "buf/gen/richter/v1/interactions_pb";
import { toast } from "sonner";
import {
  updateLessonFeedbackModeAction,
  updateLessonLanguageAction,
  updateLessonMaxAttemptsAction,
} from "./actions";

interface UseLessonAnalysisSettingsInput {
  description: string;
  initialFeedbackMode: FeedbackMode;
  initialLanguage: string;
  initialMaxAttempts: number;
  lessonId: string;
  orderIndex: number;
  title: string;
}

export function useLessonAnalysisSettings({
  description,
  initialFeedbackMode,
  initialLanguage,
  initialMaxAttempts,
  lessonId,
  orderIndex,
  title,
}: UseLessonAnalysisSettingsInput) {
  const [feedbackMode, setFeedbackModeState] = useState<FeedbackMode>(initialFeedbackMode);
  const [language, setLanguageState] = useState<string>(initialLanguage);
  const [maxAttempts, setMaxAttemptsState] = useState<number>(initialMaxAttempts);
  const [savingFeedback, startSaveFeedback] = useTransition();
  const [savingLanguage, startSaveLanguage] = useTransition();
  const [savingMaxAttempts, startSaveMaxAttempts] = useTransition();
  const languageRef = useRef(language);
  const maxAttemptsRef = useRef(maxAttempts);
  const feedbackModeRef = useRef(feedbackMode);

  useEffect(() => { languageRef.current = language; }, [language]);
  useEffect(() => { maxAttemptsRef.current = maxAttempts; }, [maxAttempts]);
  useEffect(() => { feedbackModeRef.current = feedbackMode; }, [feedbackMode]);

  const setFeedbackMode = useCallback((mode: FeedbackMode) => {
    const previous = feedbackModeRef.current;
    setFeedbackModeState(mode);
    startSaveFeedback(async () => {
      const res = await updateLessonFeedbackModeAction({ lessonId, feedbackMode: mode });
      if (!res.ok) {
        setFeedbackModeState(previous);
        toast.error(res.error);
      }
    });
  }, [lessonId, startSaveFeedback]);

  const setLanguage = useCallback((lang: string) => {
    const previous = languageRef.current;
    setLanguageState(lang);
    startSaveLanguage(async () => {
      const res = await updateLessonLanguageAction({
        lessonId, title, description, orderIndex, language: lang, maxAttempts: maxAttemptsRef.current,
      });
      if (!res.ok) {
        setLanguageState(previous);
        toast.error(res.error);
      }
    });
  }, [description, lessonId, orderIndex, startSaveLanguage, title]);

  const setMaxAttempts = useCallback((val: number) => {
    const previous = maxAttemptsRef.current;
    setMaxAttemptsState(val);
    startSaveMaxAttempts(async () => {
      const res = await updateLessonMaxAttemptsAction({
        lessonId, title, description, orderIndex, language: languageRef.current, maxAttempts: val,
      });
      if (!res.ok) {
        setMaxAttemptsState(previous);
        toast.error(res.error);
      }
    });
  }, [description, lessonId, orderIndex, startSaveMaxAttempts, title]);

  return {
    feedbackMode,
    language,
    maxAttempts,
    savingFeedback,
    savingLanguage,
    savingMaxAttempts,
    setFeedbackMode,
    setLanguage,
    setMaxAttempts,
  };
}
