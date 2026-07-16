"use client";

import { useEffect, useState } from "react";
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
 */
export function useRole(): UseRole {
  const { user, loading: authLoading } = useAuth();
  const [role, setRole] = useState<UserRole | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (authLoading) {
      return;
    }
    // Synchronizing the role summary (an external system) into local state.
    /* eslint-disable react-hooks/set-state-in-effect */
    if (!user) {
      setRole(null);
      setLoading(false);
      return;
    }

    let active = true;
    setLoading(true);
    /* eslint-enable react-hooks/set-state-in-effect */
    getMyRole()
      .then((next) => {
        if (active) {
          setRole(next);
        }
      })
      .catch(() => {
        if (active) {
          setRole({ agent: false, admin: false, privileged: false, pricingTier: "user" });
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [user, authLoading]);

  return { role, loading: authLoading || loading, isAdmin: role?.admin === true };
}
