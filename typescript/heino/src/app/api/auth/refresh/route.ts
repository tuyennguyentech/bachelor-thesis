import { cookies, headers } from "next/headers";
import { NextResponse } from "next/server";
import {
  COOKIE_ACCESS, COOKIE_REFRESH, COOKIE_OPTS, REFRESH_COOKIE_OPTS, cookieSecure, silentRefresh,
} from "@/lib/refresh";

export async function POST() {
  const jar = await cookies();
  const refreshToken = jar.get(COOKIE_REFRESH)?.value;

  if (!refreshToken) {
    const res = NextResponse.json({ error: "no refresh token" }, { status: 401 });
    res.cookies.delete(COOKIE_ACCESS);
    res.cookies.delete(COOKIE_REFRESH);
    return res;
  }

  const outcome = await silentRefresh(refreshToken);

  if (!outcome) {
    const res = NextResponse.json({ error: "refresh failed" }, { status: 401 });
    res.cookies.delete(COOKIE_ACCESS);
    res.cookies.delete(COOKIE_REFRESH);
    return res;
  }

  const res = NextResponse.json({ accessToken: outcome.accessToken });
  const secure = cookieSecure((await headers()).get("x-forwarded-proto"));
  res.cookies.set(COOKIE_ACCESS, outcome.accessToken, { ...COOKIE_OPTS, secure });
  res.cookies.set(COOKIE_REFRESH, outcome.refreshToken, { ...REFRESH_COOKIE_OPTS, secure });
  return res;
}
