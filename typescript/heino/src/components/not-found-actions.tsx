"use client"

import type { ReactNode } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { ArrowLeftIcon, HomeIcon, LibraryBigIcon } from "lucide-react"
import { Button } from "@/components/ui/button"

export type NotFoundScope = "generic" | "lesson" | "course" | "organization" | "admin"

type FallbackTarget = {
  href: string
  label: string
  icon: ReactNode
  variant?: "default" | "outline" | "ghost"
}

function pushTarget(targets: FallbackTarget[], target: FallbackTarget) {
  if (!targets.some((item) => item.href === target.href)) targets.push(target)
}

function buildTargets(pathname: string, scope: NotFoundScope): FallbackTarget[] {
  const courseMatch = pathname.match(
    /^\/dashboard\/organizations\/([^/]+)\/courses\/([^/]+)/,
  )
  const orgMatch = pathname.match(/^\/dashboard\/organizations\/([^/]+)/)
  const targets: FallbackTarget[] = []

  if (scope === "admin" || pathname.startsWith("/admin")) {
    pushTarget(targets, {
      href: "/admin",
      label: "Trang quản trị",
      icon: <HomeIcon className="size-4" />,
      variant: "default",
    })
  } else if (scope === "organization") {
    pushTarget(targets, {
      href: "/dashboard",
      label: "Trang chính",
      icon: <HomeIcon className="size-4" />,
      variant: "default",
    })
  } else if (scope === "lesson" && courseMatch) {
    const [, slug, courseId] = courseMatch
    pushTarget(targets, {
      href: `/dashboard/organizations/${slug}/courses`,
      label: "Danh sách khóa học",
      icon: <LibraryBigIcon className="size-4" />,
      variant: "default",
    })
    pushTarget(targets, {
      href: `/dashboard/organizations/${slug}/courses/${courseId}`,
      label: "Về khóa học",
      icon: <ArrowLeftIcon className="size-4" />,
      variant: "outline",
    })
  } else if (scope === "course" && orgMatch) {
    const [, slug] = orgMatch
    pushTarget(targets, {
      href: `/dashboard/organizations/${slug}/courses`,
      label: "Danh sách khóa học",
      icon: <LibraryBigIcon className="size-4" />,
      variant: "default",
    })
    pushTarget(targets, {
      href: `/dashboard/organizations/${slug}`,
      label: "Về tổ chức",
      icon: <ArrowLeftIcon className="size-4" />,
      variant: "outline",
    })
  } else if (courseMatch) {
    const [, slug, courseId] = courseMatch
    pushTarget(targets, {
      href: `/dashboard/organizations/${slug}/courses/${courseId}`,
      label: "Về khóa học",
      icon: <ArrowLeftIcon className="size-4" />,
      variant: "default",
    })
    pushTarget(targets, {
      href: `/dashboard/organizations/${slug}/courses`,
      label: "Danh sách khóa học",
      icon: <LibraryBigIcon className="size-4" />,
      variant: "outline",
    })
  } else if (orgMatch) {
    const [, slug] = orgMatch
    pushTarget(targets, {
      href: `/dashboard/organizations/${slug}`,
      label: "Về tổ chức",
      icon: <ArrowLeftIcon className="size-4" />,
      variant: "default",
    })
  }

  pushTarget(targets, {
    href: "/dashboard",
    label: "Trang chính",
    icon: <HomeIcon className="size-4" />,
    variant: targets.length ? "ghost" : "default",
  })

  return targets
}

export function NotFoundActions({ scope = "generic" }: { scope?: NotFoundScope }) {
  const pathname = usePathname()
  const targets = buildTargets(pathname, scope)

  return (
    <div className="flex flex-wrap items-center gap-2">
      {targets.map((target) => (
        <Button key={target.href} asChild variant={target.variant} size="sm">
          <Link href={target.href}>
            {target.icon}
            {target.label}
          </Link>
        </Button>
      ))}
    </div>
  )
}
