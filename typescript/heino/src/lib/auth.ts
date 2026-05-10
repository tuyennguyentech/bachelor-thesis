import "server-only";
import { cache } from "react";
import { fromJson } from "@bufbuild/protobuf";
import { jwtVerify } from "jose";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Code, ConnectError } from "@connectrpc/connect";
import { UserRole } from "buf/gen/richter/v1/users_pb";
import { AuthService } from "buf/gen/richter/v1/auth_pb";
import {
  MemberStatus,
  OrganizationMemberService,
  OrganizationRole,
  type OrganizationMember,
} from "buf/gen/richter/v1/organization_members_pb";
import { type JWTClaims, JWTClaimsSchema } from "buf/gen/richter/jwt/v1/jwt_pb";
import { createRichterClient } from "./connect-client";

export type { JWTClaims };

if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET is not configured");
const JWT_SECRET = new TextEncoder().encode(process.env.JWT_SECRET);

export const COOKIE_ACCESS = "dyadia_access";
export const COOKIE_REFRESH = "dyadia_refresh";

const COOKIE_OPTS = { httpOnly: true, sameSite: "lax" as const, path: "/", secure: process.env.NODE_ENV === "production" };

export interface Session {
  claims: JWTClaims;
  token: string;
}

export async function verifyJwt(token: string): Promise<JWTClaims | null> {
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET, { algorithms: ["HS256"] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return fromJson(JWTClaimsSchema, payload as any);
  } catch {
    return null;
  }
}

export const getSession = cache(async (): Promise<Session | null> => {
  const cookieStore = await cookies();
  const accessToken = cookieStore.get(COOKIE_ACCESS)?.value;

  if (accessToken) {
    const claims = await verifyJwt(accessToken);
    if (claims) return { claims, token: accessToken };
  }

  // Silent refresh: access token missing or expired — try refresh token
  const refreshToken = cookieStore.get(COOKIE_REFRESH)?.value;
  if (!refreshToken) return null;

  try {
    const client = createRichterClient(AuthService);
    const res = await client.refreshToken({ refreshToken });
    cookieStore.set(COOKIE_ACCESS, res.accessToken, COOKIE_OPTS);
    cookieStore.set(COOKIE_REFRESH, res.refreshToken, COOKIE_OPTS);
    const claims = await verifyJwt(res.accessToken);
    if (!claims) return null;
    return { claims, token: res.accessToken };
  } catch {
    return null;
  }
});

// Tier 1 — chỉ cần đăng nhập
export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (!session) redirect("/login");
  return session;
}

// Tier 2 — cần global role cụ thể (từ JWT, không tốn RPC)
export async function requireRole(...roles: UserRole[]): Promise<Session> {
  const session = await requireSession();
  if (!roles.includes(session.claims.role)) redirect("/unauthorized");
  return session;
}

export const requireAdmin   = () => requireRole(UserRole.ADMIN);
export const requireAnyUser = () => requireRole(UserRole.ADMIN, UserRole.NORMAL);

// Tier 3 — cần org-level role (tốn 1 RPC call)
export async function requireOrgMember(
  orgId: string,
  ...roles: OrganizationRole[]
): Promise<{ session: Session; member: OrganizationMember }> {
  const session = await requireSession();
  const client = createRichterClient(OrganizationMemberService, session.token);

  let member: OrganizationMember;
  try {
    const res = await client.getOrganizationMember({
      organizationId: orgId,
      userId: session.claims.sub,
    });
    if (!res.member) redirect("/unauthorized");
    member = res.member;
  } catch (err) {
    if (err instanceof ConnectError && err.code === Code.NotFound) redirect("/unauthorized");
    throw err;
  }

  if (member.status !== MemberStatus.ACTIVE) redirect("/unauthorized");
  if (roles.length > 0 && !roles.includes(member.role)) redirect("/unauthorized");

  return { session, member };
}

export function displayName(claims: JWTClaims): string {
  return [claims.firstName, claims.middleName, claims.lastName].filter(Boolean).join(" ");
}
