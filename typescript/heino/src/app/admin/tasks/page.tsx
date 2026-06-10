import { requireAdmin } from "@/lib/auth";
import { TasksMonitor } from "./tasks-monitor";

export default async function AdminTasksPage() {
  const { token } = await requireAdmin();

  return (
    <div className="flex flex-col gap-4">
      <TasksMonitor token={token} />
    </div>
  );
}
