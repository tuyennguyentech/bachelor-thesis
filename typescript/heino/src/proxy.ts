import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { jwtVerify } from "jose";

if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET is not configured");
const JWT_SECRET = new TextEncoder().encode(process.env.JWT_SECRET);
const COOKIE_ACCESS = "dyadia_access";
const COOKIE_REFRESH = "dyadia_refresh";

async function isTokenValid(token: string): Promise<boolean> {
  try {
    await jwtVerify(token, JWT_SECRET, { algorithms: ["HS256"] });
    return true;
  } catch {
    return false;
  }
}

async function tryRefresh(refreshToken: string): Promise<{ access: string; refresh: string } | null> {
  const base = process.env.RICHTER_BASE_URL;
  if (!base) return null;
  try {
    const res = await fetch(`${base}/richter.v1.AuthService/RefreshToken`, {
      method: "POST",
      headers: { "Content-Type": "application/connect+json" },
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) return null;
    const data: { accessToken?: string; refreshToken?: string } = await res.json();
    if (!data.accessToken || !data.refreshToken) return null;
    return { access: data.accessToken, refresh: data.refreshToken };
  } catch {
    return null;
  }
}

const PROTECTED_PREFIXES = ["/admin", "/dashboard"];
const COOKIE_OPTS = { httpOnly: true, sameSite: "lax" as const, path: "/", secure: process.env.NODE_ENV === "production" };

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isProtected = PROTECTED_PREFIXES.some((p) => pathname.startsWith(p));
  if (!isProtected) return NextResponse.next();

  const accessToken = request.cookies.get(COOKIE_ACCESS)?.value;
  if (accessToken && (await isTokenValid(accessToken))) {
    return NextResponse.next();
  }

  const refreshToken = request.cookies.get(COOKIE_REFRESH)?.value;
  if (refreshToken) {
    const tokens = await tryRefresh(refreshToken);
    if (tokens) {
      const response = NextResponse.next();
      response.cookies.set(COOKIE_ACCESS, tokens.access, COOKIE_OPTS);
      response.cookies.set(COOKIE_REFRESH, tokens.refresh, COOKIE_OPTS);
      return response;
    }
  }

  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("next", pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
