import Link from "next/link";
import { ChevronRightIcon } from "lucide-react";

import { cn } from "@/lib/utils";

interface BreadcrumbItem {
  label: string;
  href?: string;
}

interface BreadcrumbsProps {
  items: BreadcrumbItem[];
  className?: string;
}

export function Breadcrumbs({ items, className }: BreadcrumbsProps) {
  return (
    <nav aria-label="Breadcrumb" className={cn("flex flex-wrap items-center gap-1 text-sm text-muted-foreground", className)}>
      {items.map((item, index) => {
        const current = index === items.length - 1;
        return (
          <div key={`${item.label}:${index}`} className="flex min-w-0 items-center gap-1">
            {index > 0 && <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/70" />}
            {item.href && !current ? (
              <Link href={item.href} className="truncate hover:text-foreground">
                {item.label}
              </Link>
            ) : (
              <span className={cn("truncate", current && "text-foreground")}>{item.label}</span>
            )}
          </div>
        );
      })}
    </nav>
  );
}
