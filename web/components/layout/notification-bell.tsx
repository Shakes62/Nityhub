"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Bell, CheckCheck, Loader2, Store, Wallet, Wrench } from "lucide-react";
import { cn } from "@/lib/cn";
import { formatDate, formatMoney } from "@/lib/format";
import { getNotifications, markNotificationsRead } from "@/services/api";
import { useLiveEvents } from "@/contexts/live-events-context";
import type { UserNotification } from "@/types/engagement";

const ICONS: Record<string, typeof Bell> = {
  wallet_credited: Wallet,
  storefront_profit: Store,
  order_repaired: Wrench,
};

/** Account notifications: deposits, eStore sales, repaired orders. */
export function NotificationBell({ className }: { className?: string }) {
  const { unread: liveUnread, clearUnread, onNotification } = useLiveEvents();
  const [items, setItems] = useState<UserNotification[] | null>(null);
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      setItems(await getNotifications());
    } catch {
      setItems((current) => current ?? []);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  // Prepend live notifications so the panel is current without a refetch.
  useEffect(
    () => onNotification((note) => setItems((current) => [note, ...(current ?? []).filter((item) => item.id !== note.id)])),
    [onNotification],
  );

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const unread = (items ?? []).filter((item) => !item.read).length || liveUnread;

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && unread > 0) {
      clearUnread();
      setItems((current) => (current ?? []).map((item) => ({ ...item, read: true })));
      void markNotificationsRead().catch(() => undefined);
    }
  };

  return (
    <div ref={panelRef} className={cn("relative", className)}>
      <button
        type="button"
        onClick={toggle}
        className="relative flex size-10 items-center justify-center rounded-full text-ink-soft transition-colors hover:bg-surface-muted hover:text-ink"
        aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}
        aria-expanded={open}
      >
        <Bell className="size-5" aria-hidden />
        {unread ? (
          <span className="absolute right-1.5 top-1.5 flex min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-semibold leading-4 text-white tabular">
            {unread > 9 ? "9+" : unread}
          </span>
        ) : null}
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label="Notifications"
          className="absolute right-0 top-12 z-50 w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-border bg-surface shadow-lg animate-toast-in"
        >
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <span className="text-sm font-semibold text-ink">Notifications</span>
            <CheckCheck className="size-4 text-muted" aria-hidden />
          </div>
          <div className="max-h-[22rem] overflow-y-auto">
            {items === null ? (
              <div className="flex justify-center py-8">
                <Loader2 className="size-5 animate-spin text-muted" aria-label="Loading" />
              </div>
            ) : items.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-muted">You&apos;re all caught up.</p>
            ) : (
              <ul className="divide-y divide-border">
                {items.map((item) => {
                  const Icon = ICONS[item.type] || Bell;
                  const body = (
                    <span className="flex gap-3 px-4 py-3">
                      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand">
                        <Icon className="size-4" aria-hidden />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center justify-between gap-2">
                          <span className="truncate text-sm font-medium text-ink">{item.title}</span>
                          {item.amount ? <span className="shrink-0 text-xs font-semibold text-success tabular">+{formatMoney(item.amount)}</span> : null}
                        </span>
                        <span className="block text-xs text-muted">{item.message}</span>
                        <span className="mt-1 block text-[11px] text-muted">{formatDate(item.createdAt)}</span>
                      </span>
                    </span>
                  );
                  return (
                    <li key={item.id}>
                      {item.url ? (
                        <Link href={item.url} onClick={() => setOpen(false)} className="block transition-colors hover:bg-surface-soft">
                          {body}
                        </Link>
                      ) : body}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
