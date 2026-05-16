"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createRichterClient } from "@/lib/connect-client";
import { AuthService } from "buf/gen/richter/v1/auth_pb";
import { UserService, UserRole } from "buf/gen/richter/v1/users_pb";
import { COOKIE_ACCESS, COOKIE_REFRESH, COOKIE_OPTS, REFRESH_COOKIE_OPTS, getSession, verifyJwt, safeNext } from "@/lib/auth";
import { Code, ConnectError } from "@connectrpc/connect";

export type LoginState = { error?: string } | undefined;
export type RegisterState = { error?: string; success?: boolean } | undefined;


export async function login(_state: LoginState, formData: FormData): Promise<LoginState> {
  const email = (formData.get("email") as string)?.trim();
  const password = formData.get("password") as string;
  const next = formData.get("next") as string | null;

  if (!email || !password) return { error: "Vui lòng nhập email và mật khẩu" };

  let accessToken: string;
  try {
    const client = createRichterClient(AuthService);
    const res = await client.login({ email, password });
    accessToken = res.accessToken;

    const cookieStore = await cookies();
    cookieStore.set(COOKIE_ACCESS, res.accessToken, COOKIE_OPTS);
    cookieStore.set(COOKIE_REFRESH, res.refreshToken, REFRESH_COOKIE_OPTS);
  } catch (err) {
    if (err instanceof ConnectError && err.code === Code.PermissionDenied) {
      return { error: "Tài khoản chưa được kích hoạt" };
    }
    return { error: "Email hoặc mật khẩu không đúng" };
  }

  const claims = await verifyJwt(accessToken);
  const defaultNext = claims?.role === UserRole.NORMAL ? "/dashboard" : "/admin/users";
  redirect(safeNext(next) ?? defaultNext);
}

export async function registerUser(_state: RegisterState, formData: FormData): Promise<RegisterState> {
  const email = (formData.get("email") as string)?.trim();
  const password = formData.get("password") as string;
  const firstName = (formData.get("firstName") as string)?.trim();
  const lastName = (formData.get("lastName") as string)?.trim();
  const middleName = (formData.get("middleName") as string)?.trim() || undefined;

  if (!email || !password || !firstName || !lastName) {
    return { error: "Vui lòng điền đầy đủ thông tin" };
  }
  if (password.length < 8) {
    return { error: "Mật khẩu phải có ít nhất 8 ký tự" };
  }

  try {
    const client = createRichterClient(UserService);
    await client.registerUser({ email, password, firstName, lastName, middleName });
    return { success: true };
  } catch (err) {
    if (err instanceof ConnectError && err.code === Code.AlreadyExists) {
      return { error: "Email đã được đăng ký" };
    }
    return { error: "Không thể đăng ký tài khoản" };
  }
}

export async function logout() {
  const cookieStore = await cookies();
  const refreshToken = cookieStore.get(COOKIE_REFRESH)?.value;

  // Only attempt server-side revocation when we have a valid access token;
  // without it the Logout RPC is unauthenticated and will be rejected.
  const session = await getSession();
  if (refreshToken && session?.token) {
    try {
      const client = createRichterClient(AuthService, session.token);
      await client.logout({ refreshToken });
    } catch {}
  }

  cookieStore.delete(COOKIE_ACCESS);
  cookieStore.delete(COOKIE_REFRESH);
  redirect("/login");
}
