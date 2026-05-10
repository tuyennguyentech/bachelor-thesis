import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAnyUser, requireOrgMember } from "@/lib/auth";
import { createRichterClient } from "@/lib/connect-client";
import { OrganizationService } from "buf/gen/richter/v1/organizations_pb";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChevronLeftIcon } from "lucide-react";
import { Code, ConnectError } from "@connectrpc/connect";
import { roleName, memberStatusBadge, orgStatusBadge } from "@/lib/org-utils";

export default async function OrgDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { token } = await requireAnyUser();

  const orgClient = createRichterClient(OrganizationService, token);
  let org;
  try {
    const res = await orgClient.getOrganizationBySlug({ slug });
    org = res.organization;
  } catch (err) {
    if (err instanceof ConnectError && err.code === Code.NotFound) notFound();
    throw err;
  }
  if (!org) notFound();

  const { member } = await requireOrgMember(org.id);

  return (
    <div className="mx-auto max-w-2xl flex flex-col gap-6">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" asChild className="gap-1">
          <Link href="/dashboard/organizations">
            <ChevronLeftIcon className="size-4" />
            Tổ chức của tôi
          </Link>
        </Button>
      </div>

      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold">{org.name}</h1>
          <p className="text-sm text-muted-foreground">/{org.slug}</p>
        </div>
        {orgStatusBadge(org.status)}
      </div>

      <div className="rounded-lg border p-4 flex flex-col gap-3">
        <h2 className="font-medium">Thông tin chung</h2>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1">
            <p className="text-sm text-muted-foreground">Slug</p>
            <p className="text-sm font-mono">/{org.slug}</p>
          </div>
          <div className="space-y-1">
            <p className="text-sm text-muted-foreground">Ngày tạo</p>
            <p className="text-sm">
              {org.createdAt
                ? new Date(Number(org.createdAt.seconds) * 1000).toLocaleDateString("vi-VN")
                : "—"}
            </p>
          </div>
        </div>
      </div>

      <div className="rounded-lg border p-4 flex flex-col gap-3">
        <h2 className="font-medium">Vai trò của bạn</h2>
        <div className="flex items-center gap-3">
          <Badge variant="secondary">{roleName(member.role)}</Badge>
          {memberStatusBadge(member.status)}
        </div>
        {member.createdAt && (
          <p className="text-sm text-muted-foreground">
            Tham gia:{" "}
            {new Date(Number(member.createdAt.seconds) * 1000).toLocaleDateString("vi-VN")}
          </p>
        )}
      </div>
    </div>
  );
}
