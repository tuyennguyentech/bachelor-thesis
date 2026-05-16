import { requireAdmin } from "@/lib/auth";
import { createRichterClient } from "@/lib/connect-client";
import { OrganizationService } from "buf/gen/richter/v1/organizations_pb";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { BookOpenIcon, ChevronLeftIcon, UsersIcon } from "lucide-react";
import { DeleteOrgButton } from "./delete-org-button";
import { OrgStatusSelect } from "./org-status-select";
import { EditOrgForm } from "./edit-org-form";
import { notFound } from "next/navigation";

export default async function OrgDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { token } = await requireAdmin();
  const { slug } = await params;

  const client = createRichterClient(OrganizationService, token);

  let org;
  try {
    const res = await client.getOrganizationBySlug({ slug });
    org = res.organization;
  } catch {
    notFound();
  }

  if (!org) notFound();

  return (
    <div className="mx-auto max-w-2xl flex flex-col gap-6">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" asChild className="gap-1">
          <Link href="/admin/organizations">
            <ChevronLeftIcon className="size-4" />
            Tổ chức
          </Link>
        </Button>
      </div>

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">{org.name}</h1>
          <p className="text-sm font-mono text-muted-foreground">{org.slug}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" asChild className="gap-2">
            <Link href={`/admin/organizations/${slug}/members`}>
              <UsersIcon className="size-4" />
              Thành viên
            </Link>
          </Button>
          <Button variant="outline" size="sm" asChild className="gap-2">
            <Link href={`/admin/organizations/${slug}/courses`}>
              <BookOpenIcon className="size-4" />
              Khóa học
            </Link>
          </Button>
        </div>
      </div>

      {/* Edit info */}
      <div className="rounded-lg border p-4 flex flex-col gap-4">
        <h2 className="font-medium">Thông tin chung</h2>
        <EditOrgForm key={org.name} orgId={org.id} orgSlug={org.slug} orgName={org.name} token={token} />
      </div>

      {/* Status */}
      <div className="rounded-lg border p-4 flex items-center justify-between gap-4">
        <div>
          <h2 className="font-medium">Trạng thái</h2>
          <p className="text-sm text-muted-foreground">
            Ngày tạo:{" "}
            {org.createdAt
              ? new Date(Number(org.createdAt.seconds) * 1000).toLocaleDateString("vi-VN")
              : "—"}
          </p>
        </div>
        <OrgStatusSelect orgId={org.id} orgSlug={org.slug} currentStatus={org.status} token={token} />
      </div>

      {/* Danger zone */}
      <div className="rounded-lg border border-destructive/30 p-4 flex items-center justify-between">
        <div>
          <p className="font-medium text-sm">Xóa organization</p>
          <p className="text-xs text-muted-foreground">Hành động này không thể hoàn tác</p>
        </div>
        <DeleteOrgButton orgId={org.id} token={token} />
      </div>
    </div>
  );
}
