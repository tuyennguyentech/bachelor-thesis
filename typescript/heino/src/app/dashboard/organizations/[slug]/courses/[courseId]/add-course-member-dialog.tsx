"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useRichterWebClient } from "@/lib/connect-webclient";
import { CourseMemberService, CourseRole } from "buf/gen/richter/v1/course_members_pb";
import { UserService } from "buf/gen/richter/v1/users_pb";
import { toUserMessage } from "@/lib/connect-error";
import { PlusIcon } from "lucide-react";

const ROLE_OPTIONS = [
  { label: "Học viên", value: CourseRole.STUDENT },
  { label: "Giảng viên", value: CourseRole.TEACHER },
];

interface AddCourseMemberFormProps {
  courseId: string;
  token: string;
  onClose: () => void;
}

function AddCourseMemberForm({ courseId, token, onClose }: AddCourseMemberFormProps) {
  const router = useRouter();
  const memberClient = useRichterWebClient(CourseMemberService, token);
  const userClient = useRichterWebClient(UserService, token);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [selectedRole, setSelectedRole] = useState(String(CourseRole.STUDENT));

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const email = (fd.get("email") as string)?.trim();
    const role = parseInt(selectedRole) as CourseRole;

    if (!email) { setError("Vui lòng nhập email"); return; }
    if (isNaN(role) || role === CourseRole.UNSPECIFIED) { setError("Vai trò không hợp lệ"); return; }

    setError(null);
    startTransition(async () => {
      try {
        const userRes = await userClient.getUserByEmail({ email });
        if (!userRes.user) { setError("Không tìm thấy người dùng với email này"); return; }
        await memberClient.addCourseMember({ courseId, userId: userRes.user.id, role });
        router.refresh();
        onClose();
      } catch (err) {
        setError(toUserMessage(err, "Không thể thêm thành viên"));
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4 pt-2">
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="space-y-1.5">
        <Label htmlFor="cm-email">Email</Label>
        <Input
          id="cm-email"
          name="email"
          type="email"
          required
          placeholder="user@example.com"
          autoComplete="off"
        />
      </div>
      <div className="space-y-1.5">
        <Label>Vai trò</Label>
        <Select value={selectedRole} onValueChange={setSelectedRole}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ROLE_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={String(o.value)}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex justify-end gap-2 pt-2">
        <Button type="button" variant="outline" onClick={onClose}>
          Hủy
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? "Đang thêm…" : "Thêm"}
        </Button>
      </div>
    </form>
  );
}

interface AddCourseMemberDialogProps {
  courseId: string;
  token: string;
}

export function AddCourseMemberDialog({ courseId, token }: AddCourseMemberDialogProps) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" className="gap-2">
          <PlusIcon className="size-4" />
          Thêm thành viên
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Thêm thành viên khóa học</DialogTitle>
          <DialogDescription>
            Nhập email người dùng đã có tài khoản và chọn vai trò trong khóa học.
          </DialogDescription>
        </DialogHeader>
        <AddCourseMemberForm
          courseId={courseId}
          token={token}
          onClose={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
