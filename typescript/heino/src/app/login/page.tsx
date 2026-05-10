import { LoginForm } from "@/components/login-form";
import { ModeToggle } from "@/components/mode-toggle";

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
      <div className="w-full max-w-sm flex flex-col gap-4">
        {registered && (
          <div className="rounded-md bg-green-500/10 px-3 py-2 text-sm text-green-700 dark:text-green-400">
            Đăng ký thành công. Tài khoản đang chờ kích hoạt bởi admin.
          </div>
        )}
        <LoginForm next={next} />
      </div>
    </div>
  );
}
