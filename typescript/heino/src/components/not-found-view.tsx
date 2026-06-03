import { AlertCircleIcon } from "lucide-react"
import { NotFoundActions, type NotFoundScope } from "@/components/not-found-actions"

type NotFoundViewProps = {
  title?: string
  description?: string
  scope?: NotFoundScope
}

export function NotFoundView({
  title = "Không tìm thấy trang",
  description = "Nội dung này có thể đã bị xoá, đổi địa chỉ hoặc bạn không còn quyền truy cập.",
  scope = "generic",
}: NotFoundViewProps) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-10">
      <section className="w-full max-w-lg rounded-md border bg-card p-6 shadow-sm">
        <div className="flex items-start gap-4">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full border bg-muted text-muted-foreground">
            <AlertCircleIcon className="size-5" />
          </span>
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase text-muted-foreground">404</p>
            <h1 className="mt-1 text-xl font-semibold tracking-tight">{title}</h1>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">{description}</p>
            <div className="mt-5">
              <NotFoundActions scope={scope} />
            </div>
          </div>
        </div>
      </section>
    </main>
  )
}
