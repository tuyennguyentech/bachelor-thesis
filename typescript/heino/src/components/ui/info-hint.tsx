"use client";

import { useState } from "react";
import { Tooltip } from "radix-ui";
import { CircleHelpIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A small "?" marker that reveals a metric explanation in a real floating
 * tooltip (radix portal), so it shows reliably on hover, keyboard focus, AND
 * tap/click — unlike the native `title` attribute, which many browsers render
 * slowly or not at all.
 *
 * The trigger is deliberately left WITHOUT an accessible name (the icon is
 * aria-hidden, no aria-label): an accessible name here would be folded into the
 * parent's name (e.g. a table column header), polluting role-name test
 * selectors. The explanation is still exposed to assistive tech via the
 * `aria-describedby` radix wires from trigger → content.
 *
 * Works inside Server Components (it is a client component itself).
 */
export function InfoHint({ text, className }: { text: string; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Tooltip.Provider delayDuration={120}>
      <Tooltip.Root open={open} onOpenChange={setOpen}>
        <Tooltip.Trigger asChild>
          <button
            type="button"
            // Toggle on click so it also works on touch (no hover there), and
            // never let the click bubble to a parent link/row.
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setOpen((v) => !v);
            }}
            className={cn(
              "inline-flex cursor-help items-center justify-center rounded-full align-middle text-muted-foreground/70 transition-colors hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              className,
            )}
          >
            <CircleHelpIcon className="size-3.5" aria-hidden />
          </button>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            side="top"
            align="center"
            sideOffset={6}
            collisionPadding={8}
            className="z-50 max-w-[18rem] rounded-md border bg-popover px-3 py-2 text-xs font-normal normal-case leading-relaxed tracking-normal text-popover-foreground shadow-md data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
          >
            {text}
            <Tooltip.Arrow className="fill-popover" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
