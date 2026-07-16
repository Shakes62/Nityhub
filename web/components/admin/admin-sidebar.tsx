"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeft, LogOut, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/cn";
import { ADMIN_NAV_ITEMS } from "@/constants/admin-navigation";

interface AdminSidebarProps {
  displayName: string;
  onNavigate: () => void;
  onLogout: () => void;
}

/** Whether `href` is the active admin route (exact for /admin, prefix otherwise). */
function isActive(pathname: string, href: string): boolean {
  return href === "/admin" ? pathname === "/admin" : pathname.startsWith(href);
}

export function AdminSidebar({ displayName, onNavigate, onLogout }: AdminSidebarProps) {
  const pathname = usePathname();
  const initial = displayName.trim().charAt(0).toUpperCase() || "A";

  return (
    <div className="flex h-full flex-col gap-5 border-r border-border bg-surface px-4 py-5">
      <div className="flex items-center gap-2 px-1">
        <span className="flex size-9 items-center justify-center rounded-lg bg-ledger text-ledger-ink">
          <ShieldCheck className="size-5" />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold leading-tight text-ink">NityHub</p>
          <p className="text-[0.6875rem] font-semibold uppercase tracking-[0.08em] text-brand-strong">
            Admin
          </p>
        </div>
      </div>

      <div className="flex items-center gap-3 rounded-lg border border-border bg-surface-soft p-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-brand-soft text-sm font-semibold text-brand-strong">
          {initial}
        </span>
        <div className="min-w-0">
          <p className="text-[0.6875rem] font-semibold uppercase tracking-[0.08em] text-muted">
            Signed in as
          </p>
          <p className="truncate text-sm font-medium text-ink">{displayName}</p>
        </div>
      </div>

      <nav className="flex flex-1 flex-col gap-1">
        {ADMIN_NAV_ITEMS.map((item) => {
          const active = isActive(pathname, item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              className={cn(
                "group relative flex items-center gap-3 rounded-md px-3 py-2.5 text-sm transition-colors",
                active
                  ? "bg-brand-soft font-medium text-brand-strong"
                  : "text-ink-soft hover:bg-surface-muted",
              )}
            >
              {active ? (
                <span
                  className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-full bg-brand"
                  aria-hidden
                />
              ) : null}
              <Icon
                className={cn(
                  "size-[1.125rem] shrink-0",
                  active ? "text-brand" : "text-muted group-hover:text-ink-soft",
                )}
              />
              <span className="flex-1">{item.label}</span>
              <span className="hidden text-xs text-muted xl:inline">{item.meta}</span>
            </Link>
          );
        })}
      </nav>

      <div className="flex flex-col gap-1">
        <Link
          href="/dashboard"
          onClick={onNavigate}
          className="group flex items-center gap-2 rounded-md px-3 py-2.5 text-sm text-ink-soft transition-colors hover:bg-surface-muted"
        >
          <ArrowLeft className="size-4 text-muted group-hover:text-ink-soft" />
          Back to app
        </Link>
        <button
          type="button"
          onClick={onLogout}
          className="group flex items-center gap-2 rounded-md px-3 py-2.5 text-sm text-ink-soft transition-colors hover:bg-surface-muted hover:text-danger"
        >
          <LogOut className="size-4 text-muted group-hover:text-danger" />
          Logout
        </button>
      </div>
    </div>
  );
}
