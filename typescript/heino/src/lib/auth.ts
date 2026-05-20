import "server-only";
import { cache } from "react";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { Code, ConnectError } from "@connectrpc/connect";
import { UserRole } from "buf/gen/richter/v1/users_pb";
import {
  MemberStatus,
  OrganizationMemberService,
  OrganizationRole,
  type OrganizationMember,
} from "buf/gen/richter/v1/organization_members_pb";
import { type JWTClaims } from "buf/gen/richter/jwt/v1/jwt_pb";
import { createRichterClient } from "./connect-client";
import {
  COOKIE_ACCESS, COOKIE_REFRESH, COOKIE_OPTS, REFRESH_COOKIE_OPTS,
  verifyAccessJwt,
} from "./refresh";

export type { JWTClaims };

// Re-export so actions/auth.ts (which imports from "@/lib/auth") still works.
export { COOKIE_ACCESS, COOKIE_REFRESH, COOKIE_OPTS, REFRESH_COOKIE_OPTS };
export const verifyJwt = verifyAccessJwt;

const ALLOWED_NEXT_PREFIXES = ["/admin", "/dashboard"];
export function safeNext(next: string | null | undefined): string | null {
  if (next && ALLOWED_NEXT_PREFIXES.some((p) => next === p || next.startsWith(p + "/"))) return next;
  return null;
}

export interface Session {
  claims: JWTClaims;
  token: string;
}

// Read-only — silent refresh is handled upstream by proxy.ts middleware.
export const getSession = cache(async (): Promise<Session | null> => {
  const cookieStore = await cookies();
  const accessToken = cookieStore.get(COOKIE_ACCESS)?.value;
  if (!accessToken) return null;
  const claims = await verifyAccessJwt(accessToken);
  if (!claims) return null;
  return { claims, token: accessToken };
});

export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (session) return session;

  const hdrs = await headers();
  const path = safeNext(hdrs.get("x-pathname"));
  redirect(path ? `/login?next=${encodeURIComponent(path)}` : "/login");
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
