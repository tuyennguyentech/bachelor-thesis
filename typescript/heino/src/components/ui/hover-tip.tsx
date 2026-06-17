"use client";

import { useState, type ReactNode } from "react";
import { Tooltip } from "radix-ui";

/**
 * A lightweight floating tooltip around arbitrary trigger content. Shows
 * reliably on hover, keyboard focus AND tap — unlike the native `title`
 * attribute, which many browsers render slowly, unreliably, or not at all.
 * Use for small visual markers (e.g. heatmap-style squares) whose meaning is
 * otherwise hidden.
 */
export function HoverTip({
  label,
  children,
  side = "top",
}: {
  label: ReactNode;
  children: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
}) {
  const [open, setOpen] = useState(false);
  return (
    <Tooltip.Provider delayDuration={100}>
      <Tooltip.Root open={open} onOpenChange={setOpen}>
        <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            side={side}
            sideOffset={6}
            className="z-50 max-w-[16rem] rounded-md border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md"
          >
            {label}
            <Tooltip.Arrow className="fill-popover" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
