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
import { roleBadge, userStatusBadge, userFullName } from "@/lib/user-utils";

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
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Người dùng</h1>
        <div className="flex items-center gap-2">
          <SearchInput placeholder="ID / email..." />
          <CreateUserDialog token={token} />
        </div>
      </div>

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
                <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
                  Không có user nào
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
