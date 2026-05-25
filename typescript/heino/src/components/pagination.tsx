import Link from "next/link";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

interface PaginationProps {
  page: number;
  hasNext: boolean;
  buildHref: (page: number) => string;
}

export function Pagination({ page, hasNext, buildHref }: PaginationProps) {
  if (page <= 1 && !hasNext) return null;
  return (
    <div className="flex items-center justify-end gap-2">
      {page > 1 && (
        <Button variant="outline" size="sm" asChild>
          <Link href={buildHref(page - 1)}>
            <ChevronLeftIcon className="size-4" />
            Trước
          </Link>
        </Button>
      )}
      <span className="text-sm text-muted-foreground">Trang {page}</span>
      {hasNext && (
        <Button variant="outline" size="sm" asChild>
          <Link href={buildHref(page + 1)}>
            Sau
            <ChevronRightIcon className="size-4" />
          </Link>
        </Button>
      )}
    </div>
  );
}
