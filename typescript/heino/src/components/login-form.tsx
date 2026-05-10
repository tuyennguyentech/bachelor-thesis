"use client";

import { useActionState } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { login, type LoginState } from "@/app/actions/auth";

interface LoginFormProps extends React.ComponentProps<"form"> {
  next?: string;
}

export function LoginForm({ className, next, ...props }: LoginFormProps) {
  const [state, action, pending] = useActionState<LoginState, FormData>(login, undefined);

  return (
    <form className={cn("flex flex-col gap-6", className)} action={action} {...props}>
      {next && <input type="hidden" name="next" value={next} />}
      <FieldGroup>
        <div className="flex flex-col items-center gap-1 text-center">
          <h1 className="text-2xl font-bold">Đăng nhập</h1>
          <p className="text-sm text-balance text-muted-foreground">
            Nhập email và mật khẩu để đăng nhập
          </p>
        </div>

        {state?.error && (
          <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {state.error}
          </div>
        )}

        <Field>
          <FieldLabel htmlFor="email">Email</FieldLabel>
          <Input
            id="email"
            name="email"
            type="email"
            placeholder="admin@example.com"
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
            autoComplete="current-password"
            className="bg-background"
          />
        </Field>

        <Button type="submit" disabled={pending} className="w-full">
          {pending ? "Đang đăng nhập..." : "Đăng nhập"}
        </Button>

        <p className="text-center text-sm text-muted-foreground">
          Chưa có tài khoản?{" "}
          <Link href="/register" className="underline underline-offset-4 hover:text-foreground">
            Đăng ký
          </Link>
        </p>
      </FieldGroup>
    </form>
  );
}
