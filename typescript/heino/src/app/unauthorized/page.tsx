import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function UnauthorizedPage() {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-4 text-center">
      <p className="text-6xl font-bold text-muted-foreground">403</p>
      <h1 className="text-xl font-semibold">Không có quyền truy cập</h1>
      <p className="text-sm text-muted-foreground">Tài khoản của bạn không có quyền xem trang này.</p>
      <Button asChild variant="outline" size="sm">
        <Link href="/">Về trang chủ</Link>
      </Button>
    </div>
  );
}
