"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { UsersIcon, BuildingIcon, LayoutDashboardIcon, Activity } from "lucide-react";
import { cn } from "@/lib/utils";

export const adminNavItems = [
  { href: "/admin/users", label: "Người dùng", icon: UsersIcon },
  { href: "/admin/organizations", label: "Tổ chức", icon: BuildingIcon },
  { href: "/admin/tasks", label: "Giám sát tác vụ", icon: Activity },
];

export function AdminNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();

  return (
    <nav className="flex flex-col gap-1 p-2">
      {adminNavItems.map(({ href, label, icon: Icon }) => {
        const active = pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
              active
                ? "bg-primary/10 text-primary font-medium"
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

export function AdminSidebar() {
  return (
    <aside className="hidden h-full w-56 flex-col border-r bg-card md:flex">
      <div className="flex h-14 items-center gap-2 border-b px-4">
        <LayoutDashboardIcon className="size-5 text-primary" />
        <span className="font-semibold">Quản trị Dyadia</span>
      </div>
      <AdminNav />
    </aside>
  );
}
