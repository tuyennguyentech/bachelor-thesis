"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboardIcon, UserIcon, BuildingIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export const dashboardNavItems = [
  { href: "/dashboard", label: "Trang chính", icon: LayoutDashboardIcon, exact: true },
  { href: "/dashboard/profile", label: "Hồ sơ", icon: UserIcon },
  { href: "/dashboard/organizations", label: "Tổ chức", icon: BuildingIcon },
];

export function DashboardSidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();

  return (
    <nav className="flex flex-col gap-1 p-2">
      {dashboardNavItems.map(({ href, label, icon: Icon, exact }) => {
        const active = exact ? pathname === href : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
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

export function DashboardSidebar() {
  return (
    <aside className="hidden h-full w-56 flex-col border-r bg-card md:flex">
      <div className="flex h-14 items-center gap-2 border-b px-4">
        <LayoutDashboardIcon className="size-5 text-primary" />
        <span className="font-semibold">Dyadia</span>
      </div>
      <DashboardSidebarNav />
    </aside>
  );
}
