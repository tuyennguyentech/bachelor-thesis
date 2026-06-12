import { requireAdmin, displayName } from "@/lib/auth";
import { AdminSidebar } from "@/components/admin/sidebar";
import { logout } from "@/app/actions/auth";
import { Button } from "@/components/ui/button";
import { ModeToggle } from "@/components/mode-toggle";
import { LogOutIcon } from "lucide-react";
import { AdminMobileNav } from "./mobile-nav";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const { claims } = await requireAdmin();

  return (
    <div className="flex h-screen overflow-hidden">
      <AdminSidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="flex h-14 items-center justify-between gap-2 border-b bg-card px-4 lg:px-6">
          <div className="flex min-w-0 items-center gap-2">
            <AdminMobileNav />
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-sm font-medium">Quản trị hệ thống</span>
              <span className="truncate text-xs text-muted-foreground">
                {displayName(claims)}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <ModeToggle />
            <form action={logout}>
              <Button variant="ghost" size="sm" type="submit" className="gap-2">
                <LogOutIcon className="size-4" />
                <span className="hidden sm:inline">Đăng xuất</span>
              </Button>
            </form>
          </div>
        </header>
        <main className="flex-1 overflow-auto p-6">
          <div className="mx-auto w-full max-w-7xl">{children}</div>
        </main>
      </div>
    </div>
  );
}
