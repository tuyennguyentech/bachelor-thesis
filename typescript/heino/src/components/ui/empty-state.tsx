import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

interface EmptyStateProps {
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: ReactNode;
  className?: string;
}

export function EmptyState({ title, description, action, icon, className }: EmptyStateProps) {
  return (
    <div className={cn("flex min-h-40 items-center justify-center px-6 py-10", className)}>
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        {icon && (
          <div className="flex size-10 items-center justify-center rounded-md border bg-muted/40 text-muted-foreground">
            {icon}
          </div>
        )}
        <div className="space-y-1">
          <p className="text-sm font-medium text-foreground">{title}</p>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
        {action && <div className="pt-1">{action}</div>}
      </div>
    </div>
  );
}
