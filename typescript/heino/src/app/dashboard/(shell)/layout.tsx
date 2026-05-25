import { requireAnyUser, displayName } from "@/lib/auth";
import { DashboardSidebar } from "@/components/dashboard/sidebar";
import { logout } from "@/app/actions/auth";
import { Button } from "@/components/ui/button";
import { ModeToggle } from "@/components/mode-toggle";
import { LogOutIcon } from "lucide-react";

export default async function DashboardShellLayout({ children }: { children: React.ReactNode }) {
  const { claims } = await requireAnyUser();

  return (
    <div className="flex h-screen overflow-hidden">
      <DashboardSidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="flex h-14 items-center justify-between border-b bg-card px-6">
          <span className="text-sm text-muted-foreground">
            Xin chào, <span className="font-medium text-foreground">{displayName(claims)}</span>
          </span>
          <div className="flex items-center gap-2">
            <ModeToggle />
            <form action={logout}>
              <Button variant="ghost" size="sm" type="submit" className="gap-2">
                <LogOutIcon className="size-4" />
                Đăng xuất
              </Button>
            </form>
          </div>
        </header>
        <main className="flex-1 overflow-auto p-6">{children}</main>
      </div>
    </div>
  );
}
