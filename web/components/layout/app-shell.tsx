"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Menu } from "lucide-react";
import { cn } from "@/lib/cn";
import { useAuth } from "@/contexts/auth-context";
import { getUserProfile } from "@/services/api";
import { Sidebar } from "@/components/layout/sidebar";

/**
 * Authenticated application shell: guards the route (redirecting signed-out
 * users to /auth), renders the responsive sidebar/drawer, mobile header and
 * footer, and resolves the display name shown in the sidebar.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { user, loading, logout } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const [profileName, setProfileName] = useState<string | null>(null);

  // Redirect unauthenticated users once auth state has resolved.
  useEffect(() => {
    if (!loading && !user) {
      router.replace("/auth");
    }
  }, [loading, user, router]);

  // Resolve the profile username asynchronously; email is the derived fallback.
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

  const displayName = profileName || user?.email || "User";

  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const handleLogout = useCallback(async () => {
    await logout();
    router.replace("/auth");
  }, [logout, router]);

  // Full-screen loader while auth resolves or during the redirect.
  if (loading || !user) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="size-6 animate-spin text-brand" aria-label="Loading" />
      </div>
    );
  }

  return (
    <div className="min-h-screen lg:pl-[17.5rem]">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[17.5rem] lg:block">
        <Sidebar
          displayName={displayName}
          onNavigate={closeMenu}
          onLogout={handleLogout}
        />
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
        <Sidebar
          displayName={displayName}
          onNavigate={closeMenu}
          onLogout={handleLogout}
        />
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
        <span className="font-semibold text-ink">NityHub</span>
        <span className="ml-auto max-w-[45%] truncate text-sm text-muted">
          {displayName}
        </span>
      </header>

      <div className="mx-auto flex min-h-screen w-full max-w-5xl flex-col px-4 py-6 sm:px-6 lg:py-8">
        <main className="stagger-children flex flex-1 flex-col gap-5">{children}</main>
        <footer className="mt-8 border-t border-border pt-5 text-center text-xs text-muted">
          <span className="font-medium text-ink-soft">NityHub</span> · Reliable data
          and wallet flow
        </footer>
      </div>
    </div>
  );
}
