"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ApiError } from "@/types/api";
import type { AdminOverview } from "@/types/admin";
import { getAdminOverview } from "@/services/admin";

interface AdminDataValue {
  overview: AdminOverview | null;
  loading: boolean;
  error: string | null;
  /** Re-fetch the overview (call after any mutation). */
  reload: () => Promise<void>;
}

const AdminDataContext = createContext<AdminDataValue | null>(null);

/**
 * Fetches GET /api/admin/overview once and shares it across every admin page.
 * Because this provider lives in the admin layout, client-side navigation
 * between admin pages reuses the same data — mutations call `reload()` to
 * refresh the whole panel from the single source of truth.
 */
export function AdminDataProvider({ children }: { children: ReactNode }) {
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  const reload = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const data = await getAdminOverview();
      if (id === requestId.current) {
        setOverview(data);
      }
    } catch (err) {
      if (id === requestId.current) {
        const message =
          err instanceof ApiError || err instanceof Error ? err.message : "Failed to load admin data";
        setError(message);
      }
    } finally {
      if (id === requestId.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    // Fetching the overview is a legitimate external-system sync; reload() sets
    // loading state internally (same pattern as use-async-data).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, [reload]);

  return (
    <AdminDataContext.Provider value={{ overview, loading, error, reload }}>
      {children}
    </AdminDataContext.Provider>
  );
}

/** Access the shared admin overview. Must be used within <AdminDataProvider>. */
export function useAdminData(): AdminDataValue {
  const ctx = useContext(AdminDataContext);
  if (!ctx) {
    throw new Error("useAdminData must be used within an AdminDataProvider");
  }
  return ctx;
}
