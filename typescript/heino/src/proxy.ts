import { NextResponse, type NextRequest } from "next/server";
import {
  COOKIE_ACCESS, COOKIE_REFRESH, COOKIE_OPTS, REFRESH_COOKIE_OPTS,
  verifyAccessJwt, silentRefresh,
} from "@/lib/refresh";

const PROTECTED_PREFIXES = ["/admin", "/dashboard"];

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const isProtected = PROTECTED_PREFIXES.some((p) => pathname.startsWith(p));

  // Helper: build a pass-through response that carries x-pathname for Server
  // Components. Reads request.headers AT CALL TIME, so it reflects any prior
  // request.cookies.set() mutations (used after successful refresh).
  const passThrough = () => {
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set("x-pathname", pathname);
    return NextResponse.next({ request: { headers: requestHeaders } });
  };

  if (!isProtected) return passThrough();

  // 1) Valid access token → pass through.
  const accessToken = request.cookies.get(COOKIE_ACCESS)?.value;
  if (accessToken && (await verifyAccessJwt(accessToken))) {
    return passThrough();
  }

  // 2) No / expired access — try silent refresh.
  const refreshToken = request.cookies.get(COOKIE_REFRESH)?.value;
  if (refreshToken) {
    const refreshed = await silentRefresh(refreshToken);
    if (refreshed) {
      // CRITICAL: mutate request.cookies BEFORE building response headers.
      // request.cookies.set() updates request.headers.cookie under the hood
      // (see RequestCookies source), so passThrough() will read the rotated
      // tokens and forward them to downstream Server Components.
      request.cookies.set(COOKIE_ACCESS, refreshed.accessToken);
      request.cookies.set(COOKIE_REFRESH, refreshed.refreshToken);

      const response = passThrough();
      // Also write Set-Cookie so the browser updates its cookie jar.
      response.cookies.set(COOKIE_ACCESS, refreshed.accessToken, COOKIE_OPTS);
      response.cookies.set(COOKIE_REFRESH, refreshed.refreshToken, REFRESH_COOKIE_OPTS);
      return response;
    }
    // fallthrough: refresh failed → clear stale cookies + redirect.
  }

  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("next", pathname);
  const response = NextResponse.redirect(loginUrl);
  response.cookies.delete(COOKIE_ACCESS);
  response.cookies.delete(COOKIE_REFRESH);
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
