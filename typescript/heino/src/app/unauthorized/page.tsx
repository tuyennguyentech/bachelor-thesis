import Link from "next/link";
import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

export default function UnauthorizedPage() {
  return (
    <div className="flex min-h-svh w-full items-center justify-center p-6">
      <Card className="w-full max-w-sm text-center">
        <CardHeader className="items-center gap-3 pb-2">
          <div className="flex items-center justify-center rounded-full bg-destructive/10 p-4">
            <ShieldAlert className="size-8 text-destructive" />
          </div>
          <div>
            <p className="text-4xl font-bold text-muted-foreground">403</p>
            <h1 className="mt-1 text-lg font-semibold">Không có quyền truy cập</h1>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col items-center gap-4">
          <p className="text-sm text-muted-foreground">
            Tài khoản của bạn không có quyền xem trang này.
          </p>
          <Button asChild variant="outline" size="sm">
            <Link href="/">Về trang chủ</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
