import { getSession, requireRole, displayName } from "@/lib/auth";
import { UserRole } from "buf/gen/richter/v1/users_pb";
import { redirect } from "next/navigation";
import { DashboardSidebar } from "@/components/dashboard/sidebar";
import { logout } from "@/app/actions/auth";
import { Button } from "@/components/ui/button";
import { ModeToggle } from "@/components/mode-toggle";
import { LogOutIcon } from "lucide-react";
import { DashboardMobileNav } from "./mobile-nav";

export default async function DashboardShellLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (session?.claims.role === UserRole.ADMIN) redirect("/admin");
  const { claims } = await requireRole(UserRole.NORMAL);

  return (
    <div className="flex h-screen overflow-hidden">
      <DashboardSidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="flex h-14 items-center justify-between gap-2 border-b bg-card px-4 lg:px-6">
          <div className="flex min-w-0 items-center gap-2">
            <DashboardMobileNav />
            <span className="min-w-0 truncate text-sm text-muted-foreground">
              Xin chào, <span className="font-medium text-foreground">{displayName(claims)}</span>
            </span>
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
        <main className="flex-1 overflow-auto p-6">{children}</main>
      </div>
    </div>
  );
}
