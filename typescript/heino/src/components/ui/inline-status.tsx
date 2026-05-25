import type { ReactNode } from "react";
import { CheckCircleIcon, InfoIcon, TriangleAlertIcon, XCircleIcon } from "lucide-react";

import { cn } from "@/lib/utils";

type InlineStatusTone = "success" | "warning" | "danger" | "info" | "muted";

const toneClass: Record<InlineStatusTone, string> = {
  success: "border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-300",
  warning: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  danger: "border-destructive/30 bg-destructive/10 text-destructive",
  info: "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300",
  muted: "border-border bg-muted/40 text-muted-foreground",
};

const defaultIcon: Record<InlineStatusTone, ReactNode> = {
  success: <CheckCircleIcon className="size-4" />,
  warning: <TriangleAlertIcon className="size-4" />,
  danger: <XCircleIcon className="size-4" />,
  info: <InfoIcon className="size-4" />,
  muted: <InfoIcon className="size-4" />,
};

interface InlineStatusProps {
  tone?: InlineStatusTone;
  children: ReactNode;
  icon?: ReactNode;
  className?: string;
}

export function InlineStatus({ tone = "muted", children, icon, className }: InlineStatusProps) {
  return (
    <div className={cn("flex items-start gap-2 rounded-md border px-3 py-2 text-sm", toneClass[tone], className)}>
      <span className="mt-0.5 shrink-0">{icon ?? defaultIcon[tone]}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
