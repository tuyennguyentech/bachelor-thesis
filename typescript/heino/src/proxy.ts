import { NextResponse, type NextRequest } from "next/server";
import {
  COOKIE_ACCESS, COOKIE_REFRESH, COOKIE_OPTS, REFRESH_COOKIE_OPTS, cookieSecure,
  verifyAccessJwt, silentRefresh,
} from "@/lib/refresh";
import { isTransientError } from "@/lib/connect-error";

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
    let refreshed: Awaited<ReturnType<typeof silentRefresh>> = null;
    let backendDown = false;
    try {
      refreshed = await silentRefresh(refreshToken);
    } catch (err: unknown) {
      // Distinguish backend-down (ECONNREFUSED, fetch failed) from
      // token-expired (returns null from silentRefresh). When the
      // backend is unreachable we must NOT clear cookies and redirect
      // to login — that looks like a session expiry to the user.
      backendDown = isTransientError(err);
    }
    if (refreshed) {
      request.cookies.set(COOKIE_ACCESS, refreshed.accessToken);
      request.cookies.set(COOKIE_REFRESH, refreshed.refreshToken);

      const response = passThrough();
      const secure = cookieSecure(request.headers.get("x-forwarded-proto"));
      response.cookies.set(COOKIE_ACCESS, refreshed.accessToken, { ...COOKIE_OPTS, secure });
      response.cookies.set(COOKIE_REFRESH, refreshed.refreshToken, { ...REFRESH_COOKIE_OPTS, secure });
      return response;
    }
    if (backendDown) {
      // Backend is unreachable — let the request through so the
      // page's error boundary can show a friendly message instead
      // of redirecting to login (which looks like session expiry).
      return passThrough();
    }
    // fallthrough: refresh returned null = token genuinely expired.
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
