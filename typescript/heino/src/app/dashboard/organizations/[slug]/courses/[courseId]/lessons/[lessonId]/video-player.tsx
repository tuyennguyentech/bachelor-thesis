"use client";

import { useRef } from "react";
import type { TranscriptSegment } from "buf/gen/richter/v1/ai_pb";
import { InteractiveTranscript } from "./interactive-transcript";
import { FileTextIcon } from "lucide-react";

interface Props {
  videoUrl: string;
  segments: TranscriptSegment[];
  transcript: string;
}

export function VideoPlayer({ videoUrl, segments, transcript }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);

  return (
    <>
      <div className="rounded-lg border overflow-hidden bg-black aspect-video flex items-center justify-center">
        <video
          ref={videoRef}
          src={videoUrl}
          controls
          className="w-full h-full"
          preload="metadata"
        />
      </div>

      {/* Interactive transcript (if segments available) or plain text */}
      {(segments.length > 0 || transcript) && (
        <div className="rounded-lg border p-4 flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <FileTextIcon className="size-4 text-muted-foreground" />
            <h2 className="font-medium text-sm">Phiên âm nội dung</h2>
            {segments.length > 0 && (
              <span className="text-xs text-muted-foreground">
                (nhấn vào đoạn để tua video)
              </span>
            )}
          </div>
          {segments.length > 0 ? (
            <InteractiveTranscript segments={segments} videoRef={videoRef} />
          ) : (
            <p className="text-sm text-muted-foreground whitespace-pre-wrap leading-relaxed">
              {transcript}
            </p>
          )}
        </div>
      )}
    </>
  );
}
