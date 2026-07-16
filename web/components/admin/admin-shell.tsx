"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, Menu, ShieldAlert } from "lucide-react";
import { cn } from "@/lib/cn";
import { useAuth } from "@/contexts/auth-context";
import { useRole } from "@/hooks/use-role";
import { getUserProfile } from "@/services/api";
import { AdminSidebar } from "@/components/admin/admin-sidebar";
import { AdminDataProvider } from "@/contexts/admin-data-context";
import { buttonVariants } from "@/components/ui/button";

/** Centered full-screen spinner used while auth/role resolve. */
function FullScreenLoader() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <Loader2 className="size-6 animate-spin text-brand" aria-label="Loading" />
    </div>
  );
}

/**
 * Authenticated + admin-gated shell for the /admin section. Signed-out users
 * are bounced to /auth; signed-in non-admins get an explicit access-denied
 * screen (admin content is never rendered for them). The backend independently
 * rejects every /api/admin/* call from non-admins with 403.
 */
export function AdminShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { user, loading: authLoading, logout } = useAuth();
  const { isAdmin, loading: roleLoading } = useRole();
  const [menuOpen, setMenuOpen] = useState(false);
  const [profileName, setProfileName] = useState<string | null>(null);

  useEffect(() => {
    if (!authLoading && !user) {
      router.replace("/auth");
    }
  }, [authLoading, user, router]);

  useEffect(() => {
    if (!user) {
      return;
    }
    let active = true;
    getUserProfile()
      .then((profile) => {
        if (active) {
          setProfileName(profile.username || null);
        }
      })
      .catch(() => {
        /* keep the email fallback */
      });
    return () => {
      active = false;
    };
  }, [user]);

  const displayName = profileName || user?.email || "Admin";
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const handleLogout = useCallback(async () => {
    await logout();
    router.replace("/auth");
  }, [logout, router]);

  // Wait for both auth and the role check before deciding what to render.
  if (authLoading || !user || roleLoading) {
    return <FullScreenLoader />;
  }

  // Signed in, resolved, and not an admin → hard stop.
  if (!isAdmin) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <div className="w-full max-w-sm rounded-card border border-border bg-surface p-8 text-center shadow-sm">
          <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-danger-soft text-danger">
            <ShieldAlert className="size-6" />
          </div>
          <h1 className="mt-4 text-lg font-semibold text-ink">Admin access required</h1>
          <p className="mt-1 text-sm text-muted">
            Your account doesn&apos;t have permission to view this area.
          </p>
          <Link href="/dashboard" className={cn(buttonVariants("primary", "md"), "mt-5 w-full")}>
            Back to app
          </Link>
        </div>
      </div>
    );
  }

  return (
    <AdminDataProvider>
      <div className="min-h-screen lg:pl-[17.5rem]">
        {/* Desktop sidebar */}
        <aside className="fixed inset-y-0 left-0 z-30 hidden w-[17.5rem] lg:block">
          <AdminSidebar displayName={displayName} onNavigate={closeMenu} onLogout={handleLogout} />
        </aside>

        {/* Mobile drawer + overlay */}
        <div
          className={cn(
            "fixed inset-0 z-40 bg-ink/45 backdrop-blur-[2px] transition-opacity lg:hidden",
            menuOpen ? "opacity-100" : "pointer-events-none opacity-0",
          )}
          onClick={closeMenu}
          aria-hidden
        />
        <aside
          className={cn(
            "fixed inset-y-0 left-0 z-50 w-[17.5rem] shadow-lg transition-transform duration-300 lg:hidden",
            menuOpen ? "translate-x-0" : "-translate-x-full",
          )}
        >
          <AdminSidebar displayName={displayName} onNavigate={closeMenu} onLogout={handleLogout} />
        </aside>

        {/* Mobile header */}
        <header className="sticky top-0 z-20 flex items-center gap-3 border-b border-border bg-surface/85 px-4 py-3 backdrop-blur lg:hidden">
          <button
            type="button"
            onClick={() => setMenuOpen(true)}
            className="flex size-9 items-center justify-center rounded-lg border border-border text-ink-soft"
            aria-label="Open menu"
          >
            <Menu className="size-5" />
          </button>
          <span className="font-semibold text-ink">Admin</span>
          <span className="ml-auto max-w-[45%] truncate text-sm text-muted">{displayName}</span>
        </header>

        <div className="mx-auto flex min-h-screen w-full max-w-6xl flex-col px-4 py-6 sm:px-6 lg:py-8">
          <main className="flex flex-1 flex-col gap-5">{children}</main>
        </div>
      </div>
    </AdminDataProvider>
  );
}
