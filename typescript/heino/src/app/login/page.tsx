import { LoginForm } from "@/components/login-form";
import { ModeToggle } from "@/components/mode-toggle";
import { GraduationCap } from "lucide-react";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; registered?: string }>;
}) {
  const { next, registered } = await searchParams;

  return (
    <div className="relative flex min-h-svh w-full items-center justify-center p-6 md:p-10">
      <div className="absolute top-4 right-4">
        <ModeToggle />
      </div>
      <div className="w-full max-w-sm flex flex-col gap-6">
        <div className="flex flex-col items-center gap-2">
          <div className="flex items-center justify-center rounded-full bg-primary/10 p-3">
            <GraduationCap className="size-7 text-primary" />
          </div>
          <span className="text-2xl font-bold tracking-tight">Dyadia</span>
        </div>
        {registered && (
          <div className="rounded-md bg-green-500/10 px-3 py-2 text-sm text-green-700 dark:text-green-400">
            Đăng ký thành công. Tài khoản đang chờ quản trị viên kích hoạt.
          </div>
        )}
        <LoginForm next={next} />
      </div>
    </div>
  );
}
