"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BookOpenIcon, HomeIcon, UsersIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface OrgNavProps {
  slug: string;
}

const navItems = [
  { segment: "", label: "Tổng quan", icon: HomeIcon, exact: true },
  { segment: "courses", label: "Khóa học", icon: BookOpenIcon },
  { segment: "members", label: "Thành viên", icon: UsersIcon },
];

export function OrgNav({ slug }: OrgNavProps) {
  const pathname = usePathname();
  const baseHref = `/dashboard/organizations/${slug}`;

  return (
    <nav className="flex gap-1 overflow-x-auto lg:flex-col lg:overflow-visible">
      {navItems.map(({ segment, label, icon: Icon, exact }) => {
        const href = segment ? `${baseHref}/${segment}` : baseHref;
        const active = exact ? pathname === href : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            className={cn(
              "inline-flex min-w-fit items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
              active
                ? "bg-primary/10 font-medium text-primary"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            <Icon className="size-4" />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
