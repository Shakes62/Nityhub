"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/contexts/auth-context";
import { getMyRole } from "@/services/api";
import type { UserRole } from "@/types/models";

interface UseRole {
  role: UserRole | null;
  loading: boolean;
  isAdmin: boolean;
}

/**
 * Resolve the signed-in user's role summary from GET /api/me/role. Re-runs when
 * the Firebase user changes. Returns loading until both auth and the role
 * request settle. This is the client gate for admin UI; the backend enforces
 * admin access independently on every /api/admin/* route.
 *
 * The role is also re-checked whenever the tab regains focus, so an admin whose
 * access is revoked while the panel is open drops to the access-denied screen
 * instead of sitting on stale data until they happen to reload.
 */
export function useRole(): UseRole {
  const { user, loading: authLoading } = useAuth();
  const [role, setRole] = useState<UserRole | null>(null);
  const [loading, setLoading] = useState(true);
  // Guards against an earlier in-flight check landing after a later one.
  const requestId = useRef(0);

  const check = useCallback(
    async ({ silent }: { silent: boolean }) => {
      const id = ++requestId.current;
      if (!silent) {
        setLoading(true);
      }
      try {
        const next = await getMyRole();
        if (id === requestId.current) {
          setRole(next);
        }
      } catch {
        // A failed background re-check is not evidence of a revoke — a flaky
        // network must not eject an admin mid-task. Only the initial resolve
        // falls closed, because there the alternative is rendering the panel
        // having never confirmed the role.
        if (id === requestId.current && !silent) {
          setRole({ admin: false });
        }
      } finally {
        if (id === requestId.current && !silent) {
          setLoading(false);
        }
      }
    },
    [],
  );

  useEffect(() => {
    if (authLoading) {
      return;
    }
    // Synchronizing the role summary (an external system) into local state.
    /* eslint-disable react-hooks/set-state-in-effect */
    if (!user) {
      requestId.current += 1;
      setRole(null);
      setLoading(false);
      return;
    }
    /* eslint-enable react-hooks/set-state-in-effect */

    void check({ silent: false });
  }, [user, authLoading, check]);

  useEffect(() => {
    if (!user) {
      return;
    }

    // Silent so returning to the tab never flashes the shell back to a spinner.
    const recheck = () => {
      if (document.visibilityState === "visible") {
        void check({ silent: true });
      }
    };

    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", recheck);
    return () => {
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", recheck);
    };
  }, [user, check]);

  return { role, loading: authLoading || loading, isAdmin: role?.admin === true };
}
