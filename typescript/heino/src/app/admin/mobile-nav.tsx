"use client";

import { useState } from "react";
import { MenuIcon, XIcon, LayoutDashboardIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AdminNav } from "@/components/admin/sidebar";

export function AdminMobileNav() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="md:hidden"
        aria-label="Mở menu điều hướng"
        onClick={() => setOpen(true)}
      >
        <MenuIcon className="size-5" />
      </Button>

      {open && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div
            className="absolute inset-0 bg-black/50"
            aria-hidden
            onClick={() => setOpen(false)}
          />
          <aside className="absolute inset-y-0 left-0 flex w-64 max-w-[80%] flex-col border-r bg-card shadow-lg">
            <div className="flex h-14 items-center justify-between gap-2 border-b px-4">
              <div className="flex items-center gap-2">
                <LayoutDashboardIcon className="size-5 text-primary" />
                <span className="font-semibold">Quản trị Dyadia</span>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Đóng menu điều hướng"
                onClick={() => setOpen(false)}
              >
                <XIcon className="size-5" />
              </Button>
            </div>
            <AdminNav onNavigate={() => setOpen(false)} />
          </aside>
        </div>
      )}
    </>
  );
}
