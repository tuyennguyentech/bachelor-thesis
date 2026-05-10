import Link from "next/link";
import { requireAnyUser } from "@/lib/auth";
import { createRichterClient } from "@/lib/connect-client";
import { OrganizationMemberService } from "buf/gen/richter/v1/organization_members_pb";
import { OrganizationService } from "buf/gen/richter/v1/organizations_pb";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ChevronRightIcon } from "lucide-react";
import { roleName, memberStatusBadge } from "@/lib/org-utils";
import { Pagination } from "@/components/pagination";

const LIMIT = 20;

export default async function OrganizationsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const { claims, token } = await requireAnyUser();
  const params = await searchParams;
  const page = Math.max(1, parseInt(params.page ?? "1", 10) || 1);
  const offset = (page - 1) * LIMIT;

  const memberClient = createRichterClient(OrganizationMemberService, token);
  const { members } = await memberClient.listUserMemberships({
    userId: claims.sub,
    limit: LIMIT,
    offset,
  });

  const orgClient = createRichterClient(OrganizationService, token);
  const orgResults = await Promise.allSettled(
    members.map((m) =>
      orgClient.getOrganizationById({ id: m.organizationId }).then((r) => r.organization),
    ),
  );
  const orgs = orgResults.map((r) => (r.status === "fulfilled" ? r.value : undefined));

  const hasNext = members.length === LIMIT;

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">Tổ chức của tôi</h1>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Tên tổ chức</TableHead>
              <TableHead>Vai trò</TableHead>
              <TableHead>Trạng thái</TableHead>
              <TableHead>Tham gia</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                  Bạn chưa tham gia tổ chức nào.
                </TableCell>
              </TableRow>
            ) : (
              members.map((m, i) => {
                const org = orgs[i];
                return (
                  <TableRow key={m.organizationId}>
                    <TableCell className="font-medium">{org?.name ?? m.organizationId}</TableCell>
                    <TableCell>{roleName(m.role)}</TableCell>
                    <TableCell>{memberStatusBadge(m.status)}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {m.createdAt
                        ? new Date(Number(m.createdAt.seconds) * 1000).toLocaleDateString("vi-VN")
                        : "—"}
                    </TableCell>
                    <TableCell>
                      {org?.slug && (
                        <Button variant="ghost" size="sm" asChild>
                          <Link href={`/dashboard/organizations/${org.slug}`}>
                            <ChevronRightIcon className="size-4" />
                          </Link>
                        </Button>
                      )}
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
        buildHref={(p) => `/dashboard/organizations?page=${p}`}
      />
    </div>
  );
}
