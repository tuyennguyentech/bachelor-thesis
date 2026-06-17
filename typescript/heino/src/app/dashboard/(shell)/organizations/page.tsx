import Link from "next/link";
import { requireAnyUser } from "@/lib/auth";
import { createRichterClient } from "@/lib/connect-client";
import { OrganizationMemberService, MemberStatus } from "buf/gen/richter/v1/organization_members_pb";
import type { OrganizationMember } from "buf/gen/richter/v1/organization_members_pb";
import { ChevronRightIcon, BuildingIcon, MailIcon } from "lucide-react";
import { roleName, memberStatusBadge } from "@/lib/org-utils";
import { OrgInvitationActions } from "./org-invitation-actions";
import { Pagination } from "@/components/pagination";
import { CreateOrgDialog } from "@/app/dashboard/organizations/create-org-dialog";
import { RecentAccessRecorder } from "@/components/dashboard/recent-access-recorder";
import { EmptyState } from "@/components/ui/empty-state";
import { formatDate } from "@/lib/date-utils";

const LIMIT = 20;

/** A pending-invitation card — visually distinct (amber) so it stands out as an
 *  action that needs a decision, not a passive org tile. */
function InvitationCard({ m }: { m: OrganizationMember }) {
  return (
    <div
      className="flex flex-col gap-3 rounded-lg border border-amber-300 bg-amber-50/70 p-4 shadow-sm dark:border-amber-800/60 dark:bg-amber-950/20"
      data-testid="org-card"
    >
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400">
          <MailIcon className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">{m.organizationName || m.organizationId}</p>
          <p className="text-xs text-muted-foreground">
            Mời với vai trò {roleName(m.role)}
            {m.createdAt ? ` · ${formatDate(m.createdAt)}` : ""}
          </p>
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        Bạn được mời tham gia <span className="font-medium text-foreground">{m.organizationName}</span>.
      </p>
      <OrgInvitationActions
        orgId={m.organizationId}
        slug={m.organizationSlug || undefined}
        orgName={m.organizationName || "tổ chức này"}
      />
    </div>
  );
}

/** A card for an org the user has already joined (active or suspended). */
function JoinedOrgCard({ m }: { m: OrganizationMember }) {
  const href = m.organizationSlug ? `/dashboard/organizations/${m.organizationSlug}` : null;
  const body = (
    <div
      className="group flex h-full flex-col gap-3 rounded-lg border bg-card p-4 shadow-sm transition-colors hover:border-primary/40 hover:bg-accent/30"
      data-testid="org-card"
    >
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          <BuildingIcon className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">{m.organizationName || m.organizationId}</p>
          <p className="text-xs text-muted-foreground">{roleName(m.role)}</p>
        </div>
        {href && (
          <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
        )}
      </div>
      <div className="mt-auto flex items-center justify-between gap-2">
        {memberStatusBadge(m.status)}
        {m.createdAt && (
          <span className="text-xs text-muted-foreground">Tham gia {formatDate(m.createdAt)}</span>
        )}
      </div>
    </div>
  );
  return href ? (
    <Link href={href} className="block">
      {body}
    </Link>
  ) : (
    body
  );
}

export default async function OrganizationsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const { claims, token } = await requireAnyUser();
  const params = await searchParams;
  const page = Math.max(1, parseInt(params.page ?? "1", 10) || 1);
  const offset = (page - 1) * LIMIT;

  // One round-trip: the membership rows now embed the org name + slug (JOIN), so
  // no per-org getOrganizationById fan-out.
  const memberClient = createRichterClient(OrganizationMemberService, token);
  const { members } = await memberClient.listUserMemberships({
    userId: claims.sub,
    limit: LIMIT,
    offset,
  });

  const invitations = members.filter((m) => m.status === MemberStatus.INVITED);
  const joined = members.filter((m) => m.status !== MemberStatus.INVITED);
  const hasNext = members.length === LIMIT;

  return (
    <div className="flex flex-col gap-6">
      <RecentAccessRecorder
        exactPath
        entry={{
          userId: claims.sub,
          id: "dashboard:organizations",
          type: "dashboard-organizations",
          title: "Tổ chức của tôi",
          subtitle: "Trang chính",
          href: "/dashboard/organizations",
        }}
      />

      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Tổ chức của tôi</h1>
        <CreateOrgDialog token={token} userId={claims.sub} />
      </div>

      {/* Pending invitations — hoisted to the top so they're never missed. */}
      {invitations.length > 0 && (
        <section className="flex flex-col gap-3" data-testid="invitations-section">
          <div className="flex items-center gap-2">
            <MailIcon className="size-4 text-amber-600 dark:text-amber-400" />
            <h2 className="font-medium">Lời mời tham gia</h2>
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700 dark:bg-amber-900/40 dark:text-amber-400">
              {invitations.length}
            </span>
          </div>
          <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
            {invitations.map((m) => (
              <InvitationCard key={m.organizationId} m={m} />
            ))}
          </div>
        </section>
      )}

      {/* Joined organizations. */}
      {members.length === 0 ? (
        <div className="rounded-md border">
          <EmptyState
            icon={<BuildingIcon className="size-5" />}
            title="Bạn chưa tham gia tổ chức nào"
            description="Tạo tổ chức mới hoặc liên hệ quản trị viên để được mời tham gia."
          />
        </div>
      ) : joined.length > 0 ? (
        <section className="flex flex-col gap-3">
          {invitations.length > 0 && (
            <h2 className="font-medium text-muted-foreground">Đã tham gia</h2>
          )}
          <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
            {joined.map((m) => (
              <JoinedOrgCard key={m.organizationId} m={m} />
            ))}
          </div>
        </section>
      ) : null}

      <Pagination
        page={page}
        hasNext={hasNext}
        buildHref={(p) => `/dashboard/organizations?page=${p}`}
      />
    </div>
  );
}
