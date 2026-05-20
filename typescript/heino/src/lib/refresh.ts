// Shared by proxy.ts (sets cookies on response) and lib/auth.ts (reads cookies).
// MUST NOT import "server-only" or "next/headers" — proxy.ts imports this file.
import { fromJson } from "@bufbuild/protobuf";
import { jwtVerify } from "jose";
import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { AuthService } from "buf/gen/richter/v1/auth_pb";
import { JWTClaimsSchema, TokenType, type JWTClaims } from "buf/gen/richter/jwt/v1/jwt_pb";

const richterBaseUrl = process.env.RICHTER_BASE_URL;
if (!richterBaseUrl) throw new Error("RICHTER_BASE_URL must be provided");
if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET is not configured");
const JWT_SECRET = new TextEncoder().encode(process.env.JWT_SECRET);

export const COOKIE_ACCESS = "dyadia_access";
export const COOKIE_REFRESH = "dyadia_refresh";
export const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: "lax" as const,
  path: "/",
  secure: process.env.NODE_ENV === "production",
};
export const REFRESH_COOKIE_OPTS = { ...COOKIE_OPTS, maxAge: 7 * 24 * 60 * 60 };

// Module-level transport (no per-request auth) — refresh RPC is unauthenticated.
const refreshTransport = createConnectTransport({
  httpVersion: "2",
  baseUrl: richterBaseUrl,
});

export async function verifyAccessJwt(token: string): Promise<JWTClaims | null> {
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET, {
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
  } catch {
    return null;
  }
}
