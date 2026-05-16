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

const PROTECTED_PREFIXES = ["/admin", "/dashboard"];

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isProtected = PROTECTED_PREFIXES.some((p) => pathname.startsWith(p));
  if (!isProtected) return NextResponse.next();

  const accessToken = request.cookies.get(COOKIE_ACCESS)?.value;
  if (accessToken && (await isTokenValid(accessToken))) {
    return NextResponse.next();
  }

  // Access token missing or expired — if a refresh token exists, let the server
  // component's getSession() handle the refresh silently on the next render.
  const refreshToken = request.cookies.get(COOKIE_REFRESH)?.value;
  if (refreshToken) {
    return NextResponse.next();
  }

  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("next", pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
