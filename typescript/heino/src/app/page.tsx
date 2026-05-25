import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { UserRole } from "buf/gen/richter/v1/users_pb";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ModeToggle } from "@/components/mode-toggle";
import { BarChart3Icon, BotIcon, VideoIcon } from "lucide-react";

export default async function Home() {
  const session = await getSession();
  if (session?.claims.role === UserRole.ADMIN) redirect("/admin/users");
  if (session?.claims.role === UserRole.NORMAL) redirect("/dashboard");

  return (
    <div className="flex min-h-svh flex-col">
      <header className="flex h-14 items-center justify-between border-b px-6">
        <span className="font-semibold">Dyadia</span>
        <div className="flex items-center gap-2">
          <ModeToggle />
          <Button variant="ghost" size="sm" asChild>
            <Link href="/login">Đăng nhập</Link>
          </Button>
          <Button size="sm" asChild>
            <Link href="/register">Đăng ký</Link>
          </Button>
        </div>
      </header>

      <main className="flex flex-1 flex-col items-center justify-center gap-12 px-6 py-16 text-center">
        <div className="flex max-w-xl flex-col gap-4">
          <h1 className="text-4xl font-bold tracking-tight">
            Dyadia - Nền tảng học tập chủ động qua video bài giảng
          </h1>
          <p className="text-lg text-muted-foreground">
            Học tập hiệu quả hơn với video tương tác, câu hỏi AI và theo dõi tiến trình.
          </p>
          <div className="flex justify-center gap-3">
            <Button asChild size="lg">
              <Link href="/login">Đăng nhập</Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link href="/register">Đăng ký</Link>
            </Button>
          </div>
        </div>

        <div className="grid w-full max-w-2xl grid-cols-1 gap-6 text-left sm:grid-cols-3">
          <div className="flex flex-col gap-2 rounded-md border p-4">
            <VideoIcon className="size-6 text-primary" />
            <p className="font-medium">Video bài giảng tương tác</p>
            <p className="text-sm text-muted-foreground">
              Xem và tương tác trực tiếp với nội dung bài học.
            </p>
          </div>
          <div className="flex flex-col gap-2 rounded-md border p-4">
            <BotIcon className="size-6 text-primary" />
            <p className="font-medium">Câu hỏi tự động từ AI</p>
            <p className="text-sm text-muted-foreground">
              Hệ thống AI tự sinh câu hỏi kiểm tra kiến thức.
            </p>
          </div>
          <div className="flex flex-col gap-2 rounded-md border p-4">
            <BarChart3Icon className="size-6 text-primary" />
            <p className="font-medium">Theo dõi tiến trình học tập</p>
            <p className="text-sm text-muted-foreground">
              Nắm bắt tiến độ học tập của từng thành viên.
            </p>
          </div>
        </div>
      </main>

      <footer className="border-t py-4 text-center text-sm text-muted-foreground">
        © 2026 Dyadia
      </footer>
    </div>
  );
}
