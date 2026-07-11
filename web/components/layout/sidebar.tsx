"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LogOut } from "lucide-react";
import { cn } from "@/lib/cn";
import { NAV_ITEMS } from "@/constants/navigation";
import { Brand } from "@/components/layout/brand";

interface SidebarProps {
  displayName: string;
  onNavigate: () => void;
  onLogout: () => void;
}

export function Sidebar({ displayName, onNavigate, onLogout }: SidebarProps) {
  const pathname = usePathname();

  return (
    <div className="flex h-full flex-col gap-5 border-r border-border bg-surface/85 px-4 py-5 backdrop-blur-xl">
      <Brand />

      <div className="rounded-lg border border-border bg-surface-soft p-3">
        <p className="text-xs text-muted">Signed in as</p>
        <p className="truncate text-sm font-medium text-ink">{displayName}</p>
      </div>

      <nav className="flex flex-1 flex-col gap-1">
        {NAV_ITEMS.map((item) => {
          const active =
            pathname === item.href || pathname.startsWith(`${item.href}/`);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              className={cn(
                "group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors",
                active
                  ? "bg-brand-soft font-medium text-brand-strong"
                  : "text-ink-soft hover:bg-surface-muted",
              )}
            >
              <Icon
                className={cn(
                  "size-5 shrink-0",
                  active ? "text-brand" : "text-muted group-hover:text-ink-soft",
                )}
              />
              <span className="flex-1">{item.label}</span>
              <span className="text-xs text-muted">{item.meta}</span>
            </Link>
          );
        })}
      </nav>

      <button
        type="button"
        onClick={onLogout}
        className="flex items-center gap-2 rounded-lg border border-border px-3 py-2.5 text-sm text-ink-soft transition-colors hover:bg-surface-muted"
      >
        <LogOut className="size-4" />
        Logout
      </button>
    </div>
  );
}
