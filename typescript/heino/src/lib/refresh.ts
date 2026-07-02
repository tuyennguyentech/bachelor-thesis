// Shared by proxy.ts (sets cookies on response) and lib/auth.ts (reads cookies).
// MUST NOT import "server-only" or "next/headers" — proxy.ts imports this file.
import { fromJson } from "@bufbuild/protobuf";
import { jwtVerify } from "jose";
import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { AuthService } from "buf/gen/richter/v1/auth_pb";
import { JWTClaimsSchema, TokenType, type JWTClaims } from "buf/gen/richter/jwt/v1/jwt_pb";
import { isTransientError } from "@/lib/connect-error";

const richterBaseUrl = process.env.RICHTER_BASE_URL;
if (!richterBaseUrl) throw new Error("RICHTER_BASE_URL must be provided");

// JWT_SECRET is a runtime secret (not needed to build the app). Read + validated
// lazily on first use, so importing this module — e.g. while `next build` collects
// page data with no secret present — does not throw. It is provided at runtime via
// env_file (compose.dev.yml) / .env.local (local dev). Fails fast on first auth use
// if still missing at runtime.
let jwtSecretKey: Uint8Array | undefined;
function jwtSecret(): Uint8Array {
  if (jwtSecretKey) return jwtSecretKey;
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is not configured");
  jwtSecretKey = new TextEncoder().encode(secret);
  return jwtSecretKey;
}

export const COOKIE_ACCESS = "dyadia_access";
export const COOKIE_REFRESH = "dyadia_refresh";
// Base options WITHOUT `secure` — `secure` is request-dependent and set by the
// cookie-writing site via cookieSecure(). A static "secure in production" flag
// would wrongly mark cookies Secure on a prod build served over plain http
// (local browsing / E2E), where the browser then drops them.
export const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: "lax" as const,
  path: "/",
};
export const REFRESH_COOKIE_OPTS = { ...COOKIE_OPTS, maxAge: 7 * 24 * 60 * 60 };

// cookieSecure reports whether auth cookies should carry the Secure attribute:
// true iff the user's connection is HTTPS. Caddy (and any reverse proxy) sets
// X-Forwarded-Proto to the original scheme, so https → Secure and http → not,
// regardless of NODE_ENV. When no proxy header is present we fall back to
// NODE_ENV so a directly-served production deployment still stays Secure.
export function cookieSecure(forwardedProto: string | null | undefined): boolean {
  if (forwardedProto) return forwardedProto.split(",")[0].trim() === "https";
  return process.env.NODE_ENV === "production";
}

// Module-level transport (no per-request auth) — refresh RPC is unauthenticated.
const refreshTransport = createConnectTransport({
  httpVersion: "2",
  baseUrl: richterBaseUrl,
});

export async function verifyAccessJwt(token: string): Promise<JWTClaims | null> {
  try {
    const { payload } = await jwtVerify(token, jwtSecret(), {
      algorithms: ["HS256"],
      issuer: "dyadia",
      audience: "dyadia-client",
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const claims = fromJson(JWTClaimsSchema, payload as any);
    if (claims.tokenType !== TokenType.ACCESS) return null;
    return claims;
  } catch {
    return null;
  }
}

export interface RefreshOutcome {
  accessToken: string;
  refreshToken: string;
  claims: JWTClaims;
}

/** Calls AuthService.RefreshToken, verifies the new access token, returns
 *  the rotated pair. Returns null on any failure (network, invalid token,
 *  server rejection). Caller is responsible for clearing cookies on null. */
export async function silentRefresh(refreshToken: string): Promise<RefreshOutcome | null> {
  try {
    const client = createClient(AuthService, refreshTransport);
    const res = await client.refreshToken({ refreshToken });
    const claims = await verifyAccessJwt(res.accessToken);
    if (!claims) return null;
    return { accessToken: res.accessToken, refreshToken: res.refreshToken, claims };
  } catch (err: unknown) {
    // Re-throw connection errors so the proxy can distinguish
    // "backend down" from "token expired" (which returns null).
    if (isTransientError(err)) throw err;
    // Token expired or invalid — return null.
    return null;
  }
}
