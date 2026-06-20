"use client";

import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import type { TranscriptSegment } from "buf/gen/richter/v1/ai_pb";

type LiveTranscript = { segments: TranscriptSegment[]; transcript: string };
type LiveContextValue = LiveTranscript & { publish: (v: LiveTranscript) => void };

const LessonAnalysisLiveContext = createContext<LiveContextValue | null>(null);

/**
 * Shares the live transcript + segments across the lesson's (separately
 * server-rendered) tabs.
 *
 * The lesson tabs are client-side and rendered ONCE on the server (a deliberate
 * perf choice — re-running ~13 RPCs per tab switch + a soft router.refresh()
 * froze this heavy page). The PROCESSING tab's analysis hook polls the pipeline
 * and holds fresh transcript/segments; the CONTENT tab's VideoPlayer only got the
 * one-time server snapshot, so a freshly-run transcription did not appear on
 * "Bài giảng" until a full reload.
 *
 * This provider bridges them WITHOUT a router.refresh: the processing tab
 * publishes its live transcript/segments here, and the content-tab VideoPlayer
 * reads them. Seeded with the one-time server values so the first paint matches
 * the page load.
 */
export function LessonAnalysisLiveProvider({
  initialSegments,
  initialTranscript,
  children,
}: {
  initialSegments: TranscriptSegment[];
  initialTranscript: string;
  children: ReactNode;
}) {
  const [live, setLive] = useState<LiveTranscript>({
    segments: initialSegments,
    transcript: initialTranscript,
  });
  const publish = useCallback((v: LiveTranscript) => {
    // Dedupe by reference: the analysis hook keeps a stable array reference while
    // unchanged, so this only re-renders consumers when the transcript actually moves.
    setLive((prev) =>
      prev.segments === v.segments && prev.transcript === v.transcript ? prev : v,
    );
  }, []);
  return (
    <LessonAnalysisLiveContext.Provider value={{ ...live, publish }}>
      {children}
    </LessonAnalysisLiveContext.Provider>
  );
}

/** Live transcript/segments, or null when rendered outside the provider. */
export function useLessonAnalysisLive(): LiveContextValue | null {
  return useContext(LessonAnalysisLiveContext);
}
