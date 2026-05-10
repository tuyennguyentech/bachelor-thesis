import Link from "next/link";
import { requireAnyUser, displayName } from "@/lib/auth";
import { createRichterClient } from "@/lib/connect-client";
import { OrganizationMemberService } from "buf/gen/richter/v1/organization_members_pb";
import { OrganizationService } from "buf/gen/richter/v1/organizations_pb";
import { Button } from "@/components/ui/button";
import { ChevronRightIcon, UserIcon, BuildingIcon } from "lucide-react";
import { roleName, memberStatusBadge } from "@/lib/org-utils";

export default async function DashboardPage() {
  const { claims, token } = await requireAnyUser();

  const memberClient = createRichterClient(OrganizationMemberService, token);
  const { members } = await memberClient.listUserMemberships({
    userId: claims.sub,
    limit: 5,
    offset: 0,
  });

  const orgClient = createRichterClient(OrganizationService, token);
  const orgResults = await Promise.allSettled(
    members.map((m) =>
      orgClient.getOrganizationById({ id: m.organizationId }).then((r) => r.organization),
    ),
  );
  const orgs = orgResults.map((r) => (r.status === "fulfilled" ? r.value : undefined));

  return (
    <div className="mx-auto max-w-2xl flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Xin chào, {displayName(claims)}!</h1>
        <p className="text-sm text-muted-foreground">Chào mừng bạn trở lại Dyadia.</p>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Link
          href="/dashboard/organizations"
          className="flex flex-col gap-1 rounded-lg border p-4 hover:bg-muted/50 transition-colors"
        >
          <div className="flex items-center gap-2 text-muted-foreground">
            <BuildingIcon className="size-4" />
            <span className="text-sm">Tổ chức của tôi</span>
          </div>
          <p className="text-sm font-medium mt-1">Xem danh sách tổ chức</p>
        </Link>

        <Link
          href="/dashboard/profile"
          className="flex flex-col gap-1 rounded-lg border p-4 hover:bg-muted/50 transition-colors"
        >
          <div className="flex items-center gap-2 text-muted-foreground">
            <UserIcon className="size-4" />
            <span className="text-sm">Hồ sơ</span>
          </div>
          <p className="text-sm font-medium mt-1">{displayName(claims)}</p>
          <p className="text-xs text-muted-foreground">Cập nhật thông tin</p>
        </Link>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h2 className="font-medium">Tổ chức gần đây</h2>
          <Button variant="ghost" size="sm" asChild>
            <Link href="/dashboard/organizations">
              Xem tất cả <ChevronRightIcon className="size-3" />
            </Link>
          </Button>
        </div>

        <div className="rounded-md border">
          {members.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Bạn chưa tham gia tổ chức nào.
            </p>
          ) : (
            <div className="divide-y">
              {members.map((m, i) => {
                const org = orgs[i];
                const row = (
                  <div className="flex items-center justify-between px-4 py-3">
                    <div className="flex flex-col gap-0.5">
                      <span className="font-medium text-sm">{org?.name ?? m.organizationId}</span>
                      <span className="text-xs text-muted-foreground">{roleName(m.role)}</span>
                    </div>
                    <div className="flex items-center gap-3">
                      {memberStatusBadge(m.status)}
                      <ChevronRightIcon className="size-4 text-muted-foreground" />
                    </div>
                  </div>
                );
                return org?.slug ? (
                  <Link
                    key={m.organizationId}
                    href={`/dashboard/organizations/${org.slug}`}
                    className="hover:bg-muted/50 transition-colors"
                  >
                    {row}
                  </Link>
                ) : (
                  <div key={m.organizationId} className="opacity-60">
                    {row}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
