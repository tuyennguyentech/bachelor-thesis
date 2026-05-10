"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { registerUser, type RegisterState } from "@/app/actions/auth";

export function RegisterForm({ className }: React.ComponentProps<"form">) {
  const router = useRouter();
  const [state, action, pending] = useActionState<RegisterState, FormData>(registerUser, undefined);

  useEffect(() => {
    if (state?.success) {
      router.push("/login?registered=1");
    }
  }, [state?.success, router]);

  return (
    <form className={cn("flex flex-col gap-6", className)} action={action}>
      <FieldGroup>
        <div className="flex flex-col items-center gap-1 text-center">
          <h1 className="text-2xl font-bold">Đăng ký</h1>
          <p className="text-balance text-sm text-muted-foreground">
            Tạo tài khoản — admin sẽ kích hoạt trước khi bạn đăng nhập được
          </p>
        </div>

        {state?.error && (
          <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {state.error}
          </div>
        )}

        <div className="grid grid-cols-3 gap-3">
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
          {pending ? "Đang đăng ký..." : "Đăng ký"}
        </Button>

        <p className="text-center text-sm text-muted-foreground">
          Đã có tài khoản?{" "}
          <Link href="/login" className="underline underline-offset-4 hover:text-foreground">
            Đăng nhập
          </Link>
        </p>
      </FieldGroup>
    </form>
  );
}
