"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { UsersIcon, BuildingIcon, LayoutDashboardIcon } from "lucide-react";
import { cn } from "@/lib/utils";

const navItems = [
  { href: "/admin/users", label: "Người dùng", icon: UsersIcon },
  { href: "/admin/organizations", label: "Tổ chức", icon: BuildingIcon },
];

export function AdminSidebar() {
  const pathname = usePathname();

  return (
    <aside className="flex h-full w-56 flex-col border-r bg-card">
      <div className="flex h-14 items-center gap-2 border-b px-4">
        <LayoutDashboardIcon className="size-5 text-primary" />
        <span className="font-semibold">Quản trị Dyadia</span>
      </div>
      <nav className="flex flex-col gap-1 p-2">
        {navItems.map(({ href, label, icon: Icon }) => {
          const active = pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
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
    </aside>
  );
}
