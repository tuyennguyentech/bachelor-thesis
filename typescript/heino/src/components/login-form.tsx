"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { EyeIcon, EyeOffIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import {
  Field,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { login, type LoginState } from "@/app/actions/auth";

interface LoginFormProps {
  className?: string;
  next?: string;
}

export function LoginForm({ className, next }: LoginFormProps) {
  const [state, action, pending] = useActionState<LoginState, FormData>(login, undefined);
  const [showPassword, setShowPassword] = useState(false);

  return (
    <Card className={cn("w-full", className)}>
      <CardHeader className="items-center text-center">
        <h1 className="text-xl font-semibold">Đăng nhập</h1>
        <CardDescription>Nhập email và mật khẩu để truy cập tài khoản</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="flex flex-col gap-5" action={action}>
          {next && <input type="hidden" name="next" value={next} />}
          <FieldGroup>
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
                placeholder="name@example.com"
                required
                autoComplete="email"
                className="bg-background"
              />
            </Field>

            <Field>
              <FieldLabel htmlFor="password">Mật khẩu</FieldLabel>
              <div className="relative">
                <Input
                  id="password"
                  name="password"
                  type={showPassword ? "text" : "password"}
                  required
                  autoComplete="current-password"
                  className="bg-background pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? "Ẩn mật khẩu" : "Hiện mật khẩu"}
                  className="absolute inset-y-0 right-0 flex items-center px-3 text-muted-foreground hover:text-foreground"
                >
                  {showPassword ? (
                    <EyeOffIcon className="size-4" />
                  ) : (
                    <EyeIcon className="size-4" />
                  )}
                </button>
              </div>
            </Field>

            <Button type="submit" disabled={pending} className="w-full">
              {pending ? "Đang đăng nhập…" : "Đăng nhập"}
            </Button>

            <p className="text-center text-sm text-muted-foreground">
              Chưa có tài khoản?{" "}
              <Link href="/register" className="underline underline-offset-4 hover:text-foreground">
                Đăng ký
              </Link>
            </p>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}
