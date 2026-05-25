import { requireAdmin } from "@/lib/auth";
import { createRichterClient } from "@/lib/connect-client";
import { UserService } from "buf/gen/richter/v1/users_pb";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CreateUserDialog } from "./create-user-dialog";
import { UserActionsMenu } from "./user-actions-menu";
import { SearchInput } from "@/components/search-input";
import { Pagination } from "@/components/pagination";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { roleBadge, userStatusBadge, userFullName } from "@/lib/user-utils";
import { UsersIcon } from "lucide-react";

const LIMIT = 20;

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; q?: string }>;
}) {
  const { token } = await requireAdmin();
  const params = await searchParams;
  const page = Math.max(1, parseInt(params.page ?? "1", 10) || 1);
  const offset = (page - 1) * LIMIT;
  const query = params.q?.trim() || undefined;

  const client = createRichterClient(UserService, token);
  const res = await client.listUsers({ limit: LIMIT, offset, query });
  const users = res.users ?? [];

  const hasNext = users.length === LIMIT;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Người dùng"
        description="Quản lý tài khoản, vai trò và trạng thái truy cập hệ thống."
        actions={
          <>
          <SearchInput placeholder="ID hoặc email…" />
          <CreateUserDialog token={token} />
          </>
        }
      />

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Email</TableHead>
              <TableHead>Tên</TableHead>
              <TableHead>Vai trò</TableHead>
              <TableHead>Trạng thái</TableHead>
              <TableHead>Ngày tạo</TableHead>
              <TableHead className="w-16" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="p-0">
                  <EmptyState
                    icon={<UsersIcon className="size-5" />}
                    title={query ? "Không tìm thấy người dùng phù hợp" : "Chưa có người dùng nào"}
                    description={
                      query
                        ? "Thử tìm bằng ID hoặc email khác."
                        : "Tạo tài khoản đầu tiên để phân quyền quản trị hoặc tham gia tổ chức."
                    }
                  />
                </TableCell>
              </TableRow>
            ) : (
              users.map((user) => (
                <TableRow key={user.id}>
                  <TableCell className="font-medium">{user.email}</TableCell>
                  <TableCell>
                    {userFullName(user)}
                  </TableCell>
                  <TableCell>{roleBadge(user.role)}</TableCell>
                  <TableCell>{userStatusBadge(user.status)}</TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {user.createdAt
                      ? new Date(Number(user.createdAt.seconds) * 1000).toLocaleDateString("vi-VN")
                      : "—"}
                  </TableCell>
                  <TableCell>
                    <UserActionsMenu userId={user.id} userStatus={user.status} token={token} />
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
        buildHref={(p) => `/admin/users?page=${p}${query ? `&q=${encodeURIComponent(query)}` : ""}`}
      />
    </div>
  );
}
