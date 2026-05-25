import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAnyUser, requireOrgMember } from "@/lib/auth";
import { createRichterClient } from "@/lib/connect-client";
import { OrganizationService, OrganizationStatus } from "buf/gen/richter/v1/organizations_pb";
import { MemberStatus } from "buf/gen/richter/v1/organization_members_pb";
import { Code, ConnectError } from "@connectrpc/connect";
import { Button } from "@/components/ui/button";
import { ModeToggle } from "@/components/mode-toggle";
import { logout } from "@/app/actions/auth";
import {
  ArrowLeftIcon,
  BuildingIcon,
  LogOutIcon,
} from "lucide-react";
import { roleName } from "@/lib/org-utils";
import { OrgNav } from "./org-nav";
import { RecentAccessRecorder } from "@/components/dashboard/recent-access-recorder";

function orgStatusText(status: OrganizationStatus): string {
  if (status === OrganizationStatus.ACTIVE) return "Đang hoạt động";
  if (status === OrganizationStatus.SUSPENDED) return "Tạm khóa";
  return "Lưu trữ";
}

function memberStatusText(status: MemberStatus): string {
  if (status === MemberStatus.ACTIVE) return "Đang hoạt động";
  if (status === MemberStatus.INVITED) return "Đã mời";
  return "Tạm khóa";
}

function statusDotClass(orgStatus: OrganizationStatus, memberStatus: MemberStatus): string {
  if (orgStatus === OrganizationStatus.ACTIVE && memberStatus === MemberStatus.ACTIVE) {
    return "bg-green-500";
  }
  if (orgStatus === OrganizationStatus.SUSPENDED || memberStatus === MemberStatus.INVITED) {
    return "bg-yellow-500";
  }
  return "bg-red-500";
}

export default async function OrganizationLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const { token } = await requireAnyUser();

  const orgClient = createRichterClient(OrganizationService, token);
  let org;
  try {
    const res = await orgClient.getOrganizationBySlug({ slug });
    org = res.organization;
  } catch (err) {
    if (
      err instanceof ConnectError &&
      (err.code === Code.NotFound || err.code === Code.PermissionDenied)
    ) {
      notFound();
    }
    throw err;
  }
  if (!org) notFound();

  const { member } = await requireOrgMember(org.id);
  const orgHref = `/dashboard/organizations/${slug}`;

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      <RecentAccessRecorder
        exactPath
        entry={{
          id: `organization:${org.id}`,
          type: "organization",
          orgSlug: slug,
          title: org.name,
          subtitle: roleName(member.role),
          href: orgHref,
        }}
      />

      <header className="flex h-14 shrink-0 items-center justify-between border-b bg-card px-4 lg:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <Button variant="ghost" size="sm" asChild className="gap-1 px-2">
            <Link href="/dashboard">
              <ArrowLeftIcon className="size-4" />
              Trang chính
            </Link>
          </Button>
          <div className="hidden h-5 w-px bg-border md:block" />
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <BuildingIcon className="size-3.5" />
              Tổ chức
            </div>
            <p className="truncate text-sm font-semibold">{org.name}</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div className="hidden items-center gap-2 rounded-md border px-2.5 py-1 text-xs text-muted-foreground md:flex">
            <span className={`size-1.5 rounded-full ${statusDotClass(org.status, member.status)}`} />
            <span>Tổ chức: {orgStatusText(org.status)}</span>
            <span className="text-border">/</span>
            <span>Thành viên: {memberStatusText(member.status)}</span>
          </div>
          <ModeToggle />
          <form action={logout}>
            <Button variant="ghost" size="sm" type="submit" className="gap-2">
              <LogOutIcon className="size-4" />
              Đăng xuất
            </Button>
          </form>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 lg:grid-cols-[260px_minmax(0,1fr)]">
        <aside className="border-b bg-card/40 p-3 lg:border-b-0 lg:border-r">
          <div className="flex h-full flex-col gap-4">
            <div className="rounded-md border bg-background p-3">
              <p className="truncate text-sm font-medium">{org.name}</p>
              <p className="mt-1 text-xs text-muted-foreground">{roleName(member.role)}</p>
            </div>
            <OrgNav slug={slug} />
          </div>
        </aside>

        <main className="min-w-0 overflow-auto p-4 lg:p-6">{children}</main>
      </div>
    </div>
  );
}
