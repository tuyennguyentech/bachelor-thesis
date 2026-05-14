// dashboard members page
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAnyUser, requireOrgMember } from "@/lib/auth";
import { createRichterClient } from "@/lib/connect-client";
import { OrganizationService } from "buf/gen/richter/v1/organizations_pb";
import { OrganizationMemberService, OrganizationRole, type OrganizationMember } from "buf/gen/richter/v1/organization_members_pb";
import { Code, ConnectError } from "@connectrpc/connect";
import { Button } from "@/components/ui/button";
import { ChevronLeftIcon } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { roleName, memberStatusBadge } from "@/lib/org-utils";
import { Pagination } from "@/components/pagination";
import { AddMemberDialog } from "@/app/admin/organizations/[slug]/members/add-member-dialog";
import { MemberActionsMenu } from "@/app/admin/organizations/[slug]/members/member-actions-menu";

const LIMIT = 50;
const CAN_MANAGE = [OrganizationRole.OWNER, OrganizationRole.ADMIN];

export default async function DashboardMembersPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);
  const offset = (page - 1) * LIMIT;

  const { token } = await requireAnyUser();

  const orgClient = createRichterClient(OrganizationService, token);
  let org;
  try {
    const res = await orgClient.getOrganizationBySlug({ slug });
    org = res.organization;
  } catch (err) {
    if (err instanceof ConnectError && (err.code === Code.NotFound || err.code === Code.PermissionDenied)) notFound();
    throw err;
  }
  if (!org) notFound();

  const { member: currentMember } = await requireOrgMember(org.id);
  const canManage = CAN_MANAGE.includes(currentMember.role);

  const memberClient = createRichterClient(OrganizationMemberService, token);
  let members: OrganizationMember[] = [];
  try {
    const res = await memberClient.listOrganizationMembers({
      organizationId: org.id,
      limit: LIMIT,
      offset,
    });
    members = res.members ?? [];
  } catch {
    members = [];
  }
  const hasNext = members.length === LIMIT;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" asChild className="gap-1">
          <Link href={`/dashboard/organizations/${slug}`}>
            <ChevronLeftIcon className="size-4" />
            {org.name}
          </Link>
        </Button>
        <h1 className="text-xl font-semibold">Thành viên</h1>
      </div>

      {canManage && (
        <div className="flex justify-end">
          <AddMemberDialog organizationId={org.id} slug={slug} />
        </div>
      )}

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Thành viên</TableHead>
              <TableHead>Vai trò</TableHead>
              <TableHead>Trạng thái</TableHead>
              <TableHead>Ngày tham gia</TableHead>
              {canManage && <TableHead className="w-12" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.length === 0 ? (
              <TableRow>
                <TableCell colSpan={canManage ? 5 : 4} className="py-10 text-center text-muted-foreground">
                  Chưa có thành viên
                </TableCell>
              </TableRow>
            ) : (
              members.map((m) => {
                const displayName = `${m.userFirstName} ${m.userLastName}`.trim() || m.userId;
                return (
                  <TableRow key={m.userId}>
                    <TableCell>
                      <div className="flex flex-col gap-0.5">
                        <span className="text-sm font-medium">{displayName}</span>
                        {m.userEmail && (
                          <span className="text-xs text-muted-foreground">{m.userEmail}</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>{roleName(m.role)}</TableCell>
                    <TableCell>{memberStatusBadge(m.status)}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {m.createdAt
                        ? new Date(Number(m.createdAt.seconds) * 1000).toLocaleDateString("vi-VN")
                        : "—"}
                    </TableCell>
                    {canManage && (
                      <TableCell>
                        <MemberActionsMenu
                          organizationId={m.organizationId}
                          userId={m.userId}
                          currentRole={m.role}
                          currentStatus={m.status}
                          slug={slug}
                        />
                      </TableCell>
                    )}
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      <Pagination
        page={page}
        hasNext={hasNext}
        buildHref={(p) => `/dashboard/organizations/${slug}/members?page=${p}`}
      />
    </div>
  );
}
