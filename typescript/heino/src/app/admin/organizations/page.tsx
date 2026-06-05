import { requireAdmin } from "@/lib/auth";
import { createRichterClient } from "@/lib/connect-client";
import { OrganizationService } from "buf/gen/richter/v1/organizations_pb";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CreateOrgDialog } from "./create-org-dialog";
import { OrgActionsMenu } from "./org-actions-menu";
import { SearchInput } from "@/components/search-input";
import { Pagination } from "@/components/pagination";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { orgStatusBadge } from "@/lib/org-utils";
import { BuildingIcon } from "lucide-react";
import { RecentAccessRecorder } from "@/components/dashboard/recent-access-recorder";

const LIMIT = 20;

export default async function OrganizationsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; q?: string }>;
}) {
  const { claims, token } = await requireAdmin();
  const params = await searchParams;
  const page = Math.max(1, parseInt(params.page ?? "1", 10) || 1);
  const offset = (page - 1) * LIMIT;
  const query = params.q?.trim() || undefined;

  const client = createRichterClient(OrganizationService, token);
  const res = await client.listOrganizations({ limit: LIMIT, offset, query });
  const orgs = res.organizations ?? [];
  const hasNext = orgs.length === LIMIT;

  return (
    <div className="flex flex-col gap-4">
      <RecentAccessRecorder
        exactPath
        entry={{
          userId: claims.sub,
          id: "admin:organizations",
          type: "admin-organizations",
          area: "admin",
          title: "Tổ chức",
          subtitle: "Quản trị hệ thống",
          href: "/admin/organizations",
        }}
      />

      <PageHeader
        title="Tổ chức"
        description="Quản lý các tổ chức, trạng thái hoạt động và quyền truy cập ban đầu."
        actions={
          <>
          <SearchInput placeholder="ID hoặc slug…" slugLabel="slug" />
          <CreateOrgDialog token={token} />
          </>
        }
      />

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Tên</TableHead>
              <TableHead>Slug</TableHead>
              <TableHead>Trạng thái</TableHead>
              <TableHead>Ngày tạo</TableHead>
              <TableHead className="w-16" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {orgs.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="p-0">
                  <EmptyState
                    icon={<BuildingIcon className="size-5" />}
                    title={query ? "Không tìm thấy tổ chức phù hợp" : "Chưa có tổ chức nào"}
                    description={
                      query
                        ? "Thử tìm bằng ID hoặc slug khác."
                        : "Tạo tổ chức đầu tiên để bắt đầu phân quyền và mở khóa học."
                    }
                  />
                </TableCell>
              </TableRow>
            ) : (
              orgs.map((org) => (
                <TableRow key={org.id}>
                  <TableCell className="font-medium">{org.name}</TableCell>
                  <TableCell className="font-mono text-sm">{org.slug}</TableCell>
                  <TableCell>{orgStatusBadge(org.status)}</TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {org.createdAt
                      ? new Date(Number(org.createdAt.seconds) * 1000).toLocaleDateString("vi-VN")
                      : "—"}
                  </TableCell>
                  <TableCell>
                    <OrgActionsMenu orgId={org.id} orgSlug={org.slug} orgStatus={org.status} token={token} />
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <Pagination
        page={page}
        hasNext={hasNext}
        buildHref={(p) => `/admin/organizations?page=${p}${query ? `&q=${encodeURIComponent(query)}` : ""}`}
      />
    </div>
  );
}
