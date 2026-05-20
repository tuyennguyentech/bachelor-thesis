"use client";

interface Marker {
  id: string;
  index: number;
  startSeconds: number;
  status: "pending" | "active" | "passed";
}

interface Props {
  markers: Marker[];
  duration: number;
  onSeek: (seconds: number) => void;
}

function formatTime(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function CheckpointMarkerStrip({ markers, duration, onSeek }: Props) {
  if (markers.length === 0 || duration <= 0) return null;

  return (
    <div className="h-1.5 bg-muted/50 relative rounded-full mx-0.5">
      {markers.map((m) => {
        const pct = Math.min(100, (m.startSeconds / duration) * 100);
        const timeStr = formatTime(m.startSeconds);

        const tooltip =
          m.status === "pending"
            ? `Câu ${m.index} sẽ hiện tại ${timeStr}`
            : m.status === "active"
            ? `Câu ${m.index} · đang ở ${timeStr}`
            : `Câu ${m.index} · đã trả lời`;

        return (
          <button
            key={m.id}
            type="button"
            data-testid={`checkpoint-marker-${m.id}`}
            data-state={m.status}
            title={tooltip}
            onClick={() => m.status === "passed" && onSeek(m.startSeconds)}
            className={[
              "absolute top-1/2 -translate-y-1/2 -translate-x-1/2 size-2.5 rounded-full transition-colors",
              m.status === "passed"
                ? "bg-green-500 cursor-pointer"
                : m.status === "active"
                ? "bg-amber-400 animate-pulse cursor-default"
                : "bg-muted-foreground/40 cursor-default",
            ].join(" ")}
            style={{ left: `${pct}%` }}
          />
        );
      })}
    </div>
  );
}
