"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

/**
 * A textarea that grows to fit its content instead of clipping long text to a
 * single line (the old `<input>` behaviour the interaction editors used).
 *
 * Used across the exercise-edit dialog so option text, questions, accepted
 * answers, etc. wrap and stay fully visible while editing — starting compact
 * (one or two rows) and expanding as the teacher types. Auto-sizing is done in
 * JS (reset height → scrollHeight) so it works in every browser, including the
 * Firefox the E2E suite drives (CSS `field-sizing` is Chromium-only).
 */
export function AutoTextarea({
  value,
  onChange,
  className,
  minRows = 1,
  ...rest
}: {
  value: string;
  onChange: (value: string) => void;
  minRows?: number;
} & Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange" | "rows" | "ref">) {
  const ref = useRef<HTMLTextAreaElement>(null);

  const resize = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    // When the field is rendered hidden (e.g. inside a not-yet-open dialog),
    // scrollHeight is 0 — keep the natural `rows` height instead of collapsing to
    // 0px; the next visible render / keystroke re-fits it.
    if (el.scrollHeight > 0) el.style.height = `${el.scrollHeight}px`;
  };

  // Re-fit when the value changes from outside (initial mount, programmatic edits).
  useEffect(() => {
    if (ref.current) resize(ref.current);
  }, [value]);

  return (
    <textarea
      ref={ref}
      rows={minRows}
      value={value}
      onChange={(e) => {
        resize(e.currentTarget);
        onChange(e.target.value);
      }}
      className={cn(
        "resize-none overflow-hidden leading-relaxed focus:outline-none focus:ring-1 focus:ring-ring",
        className,
      )}
      {...rest}
    />
  );
}
