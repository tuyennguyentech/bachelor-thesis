"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { registerUser, type RegisterState } from "@/app/actions/auth";

export function RegisterForm({ className }: { className?: string }) {
  const router = useRouter();
  const [state, action, pending] = useActionState<RegisterState, FormData>(registerUser, undefined);

  useEffect(() => {
    if (state?.success) {
      router.push("/login?registered=1");
    }
  }, [state?.success, router]);

  return (
    <Card className={cn("w-full", className)}>
      <CardHeader className="items-center text-center">
        <h1 className="text-xl font-semibold">Đăng ký</h1>
        <CardDescription>
          Tạo tài khoản; quản trị viên sẽ kích hoạt trước khi bạn đăng nhập được
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="flex flex-col gap-5" action={action}>
          <FieldGroup>
            {state?.error && (
              <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {state.error}
              </div>
            )}

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field>
                <FieldLabel htmlFor="lastName">Họ</FieldLabel>
                <Input id="lastName" name="lastName" placeholder="Nguyễn" required className="bg-background" />
              </Field>
              <Field>
                <FieldLabel htmlFor="middleName">Tên đệm</FieldLabel>
                <Input id="middleName" name="middleName" placeholder="Văn" className="bg-background" />
              </Field>
              <Field>
                <FieldLabel htmlFor="firstName">Tên</FieldLabel>
                <Input id="firstName" name="firstName" placeholder="A" required className="bg-background" />
              </Field>
            </div>

            <Field>
              <FieldLabel htmlFor="email">Email</FieldLabel>
              <Input
                id="email"
                name="email"
                type="email"
                placeholder="example@email.com"
                required
                autoComplete="email"
                className="bg-background"
              />
            </Field>

            <Field>
              <FieldLabel htmlFor="password">Mật khẩu</FieldLabel>
              <Input
                id="password"
                name="password"
                type="password"
                required
                minLength={8}
                placeholder="Ít nhất 8 ký tự"
                autoComplete="new-password"
                className="bg-background"
              />
            </Field>

            <Button type="submit" disabled={pending} className="w-full">
              {pending ? "Đang đăng ký…" : "Đăng ký"}
            </Button>

            <p className="text-center text-sm text-muted-foreground">
              Đã có tài khoản?{" "}
              <Link href="/login" className="underline underline-offset-4 hover:text-foreground">
                Đăng nhập
              </Link>
            </p>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}
