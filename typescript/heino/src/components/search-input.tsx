"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useTransition, useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { SearchIcon } from "lucide-react";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function detectField(value: string): string | null {
  if (!value) return null;
  if (UUID_RE.test(value)) return "ID";
  if (value.includes("@")) return "email";
  return null;
}

interface SearchInputProps {
  placeholder?: string;
  slugLabel?: string;
}

export function SearchInput({ placeholder = "ID hoặc email…", slugLabel }: SearchInputProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();
  const [value, setValue] = useState(searchParams.get("q") ?? "");

  // Refs let the debounce closure read latest pathname/searchParams without being deps
  const pathnameRef = useRef(pathname);
  const searchParamsRef = useRef(searchParams);
  useEffect(() => { pathnameRef.current = pathname; }, [pathname]);
  useEffect(() => { searchParamsRef.current = searchParams; }, [searchParams]);

  useEffect(() => {
    const timer = setTimeout(() => {
      const params = new URLSearchParams(searchParamsRef.current.toString());
      if (value) {
        params.set("q", value);
      } else {
        params.delete("q");
      }
      params.delete("page");
      startTransition(() => {
        router.push(`${pathnameRef.current}?${params.toString()}`);
      });
    }, 300);

    return () => clearTimeout(timer);
  }, [value, router]);

  const field = detectField(value) ?? (value && slugLabel ? slugLabel : null);

  return (
    <div className="relative w-72">
      <SearchIcon className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
      <Input
        className="pl-8 pr-20"
        placeholder={placeholder}
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      {field && (
        <span className="absolute right-2.5 top-2 text-xs text-muted-foreground bg-muted rounded px-1 py-0.5">
          {field}
        </span>
      )}
    </div>
  );
}
