import { requireAdmin } from "@/lib/auth";
import { createRichterClient } from "@/lib/connect-client";
import { OrganizationService } from "buf/gen/richter/v1/organizations_pb";
import { OrganizationMemberService, type OrganizationMember } from "buf/gen/richter/v1/organization_members_pb";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AddMemberDialog } from "./add-member-dialog";
import { MemberActionsMenu } from "./member-actions-menu";
import { Pagination } from "@/components/pagination";
import { roleName, memberStatusBadge } from "@/lib/org-utils";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Breadcrumbs } from "@/components/ui/breadcrumbs";
import { UsersIcon } from "lucide-react";

const LIMIT = 50;

export default async function MembersPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const { token } = await requireAdmin();
  const { slug } = await params;
  const sp = await searchParams;
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);
  const offset = (page - 1) * LIMIT;

  const orgClient = createRichterClient(OrganizationService, token);
  const memberClient = createRichterClient(OrganizationMemberService, token);

  let org;
  try {
    const res = await orgClient.getOrganizationBySlug({ slug });
    org = res.organization;
  } catch {
    notFound();
  }
  if (!org) notFound();

  let members: OrganizationMember[] = [];
  try {
    const membersRes = await memberClient.listOrganizationMembers({
      organizationId: org.id,
      limit: LIMIT,
      offset,
    });
    members = membersRes.members ?? [];
  } catch {
    members = [];
  }
  const hasNext = members.length === LIMIT;

  return (
    <div className="flex flex-col gap-4">
      <Breadcrumbs
        items={[
          { label: "Tổ chức", href: "/admin/organizations" },
          { label: org.name, href: `/admin/organizations/${slug}` },
          { label: "Thành viên" },
        ]}
      />

      <PageHeader
        title="Thành viên"
        description={`Quản lý thành viên và quyền truy cập trong tổ chức ${org.name}.`}
        actions={<AddMemberDialog organizationId={org.id} slug={slug} token={token} />}
      />

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Người dùng</TableHead>
              <TableHead>Vai trò</TableHead>
              <TableHead>Trạng thái</TableHead>
              <TableHead>Ngày thêm</TableHead>
              <TableHead className="w-16" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="p-0">
                  <EmptyState
                    icon={<UsersIcon className="size-5" />}
                    title="Chưa có thành viên"
                    description="Thêm thành viên để phân quyền học, dạy hoặc quản trị tổ chức."
                  />
                </TableCell>
              </TableRow>
            ) : (
              members.map((m) => {
                const displayName = `${m.userFirstName} ${m.userLastName}`.trim() || m.userEmail || m.userId;
                return (
                  <TableRow key={m.userId}>
                    <TableCell>
                      <Link href={`/admin/users/${m.userId}`} className="flex flex-col gap-0.5 hover:text-primary">
                        <span className="text-sm font-medium">{displayName}</span>
                        <span className="text-xs text-muted-foreground">{m.userEmail || m.userId}</span>
                      </Link>
                    </TableCell>
                    <TableCell>{roleName(m.role)}</TableCell>
                    <TableCell>{memberStatusBadge(m.status)}</TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {m.createdAt
                        ? new Date(Number(m.createdAt.seconds) * 1000).toLocaleDateString("vi-VN")
                        : "—"}
                    </TableCell>
                    <TableCell>
                      <MemberActionsMenu
                        organizationId={m.organizationId}
                        userId={m.userId}
                        currentRole={m.role}
                        currentStatus={m.status}
                        slug={slug}
                        token={token}
                      />
                    </TableCell>
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
        buildHref={(p) => `/admin/organizations/${slug}/members?page=${p}`}
      />
    </div>
  );
}
