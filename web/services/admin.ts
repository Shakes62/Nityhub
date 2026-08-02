import { apiRequest } from "@/services/api-client";
import type {
  AdminCatalogResult,
  AdminOverview,
  AdminPackage,
  AfaFeeResult,
  BulkStatusResult,
  OrderStatusResult,
  ProviderHealthData,
  ProviderRouting,
  ProviderRoutingData,
} from "@/types/admin";

/**
 * Typed clients for the `/api/admin/*` endpoints. Every call attaches the
 * Firebase ID token (auth: true); the backend independently enforces
 * `role.admin === true` on all of these routes, so the client-side admin
 * guard is convenience/UX only — never the security boundary.
 */

/* ------------------------------- Overview -------------------------------- */

export async function getAdminOverview(): Promise<AdminOverview> {
  const res = await apiRequest<AdminOverview>("/api/admin/overview", { auth: true });
  const data = res.data;
  return {
    users: Array.isArray(data?.users) ? data.users : [],
    walletsMap: data?.walletsMap ?? {},
    orders: Array.isArray(data?.orders) ? data.orders : [],
    transactions: Array.isArray(data?.transactions) ? data.transactions : [],
    afa: Array.isArray(data?.afa) ? data.afa : [],
  };
}

/* ------------------------------ User admin ------------------------------- */

/** Grant/revoke agent and/or admin roles. Omit a flag to leave it unchanged. */
export async function updateUserRole(
  userId: string,
  roles: { isagent?: boolean; isadmin?: boolean },
): Promise<{ userId: string; isagent: boolean; isadmin: boolean }> {
  const res = await apiRequest<{ userId: string; isagent: boolean; isadmin: boolean }>(
    `/api/admin/users/${encodeURIComponent(userId)}/role`,
    { method: "PATCH", json: roles, auth: true },
  );
  return res.data as { userId: string; isagent: boolean; isadmin: boolean };
}

/** Manually credit a user's wallet (GHS). */
export async function creditUserWallet(
  userId: string,
  amount: number,
): Promise<{ balance: number }> {
  const res = await apiRequest<{ balance: number }>(
    `/api/admin/users/${encodeURIComponent(userId)}/credit-wallet`,
    { method: "POST", json: { amount }, auth: true },
  );
  return res.data as { balance: number };
}

/** Permanently delete a user and all of their data. */
export async function deleteUser(userId: string): Promise<void> {
  await apiRequest(`/api/admin/users/${encodeURIComponent(userId)}`, {
    method: "DELETE",
    auth: true,
  });
}

/* ------------------------------- Orders ---------------------------------- */

/**
 * Set one order's status by reference. Idempotent: re-sending the status the
 * order already has succeeds with `changed: false`.
 */
export async function updateOrderStatus(
  reference: string,
  status: string,
  note?: string,
): Promise<OrderStatusResult> {
  const res = await apiRequest<OrderStatusResult>(
    `/api/admin/orders/${encodeURIComponent(reference)}/status`,
    { method: "PATCH", json: { status, ...(note ? { note } : {}) }, auth: true },
  );
  return res.data as OrderStatusResult;
}

/**
 * Bulk re-status orders, either by an explicit reference list or by a UTC date
 * range plus a source status. Dates are `YYYY-MM-DD`.
 */
export async function bulkUpdateOrderStatus(input: {
  startDate?: string;
  endDate?: string;
  currentStatus?: string;
  nextStatus: string;
  references?: string[];
}): Promise<BulkStatusResult> {
  const res = await apiRequest<BulkStatusResult>("/api/admin/orders/bulk-status", {
    method: "PATCH",
    json: input,
    auth: true,
  });
  return res.data as BulkStatusResult;
}

/* ------------------------------- Catalog --------------------------------- */

export async function getAdminPackages(network: string): Promise<AdminCatalogResult> {
  const res = await apiRequest<AdminPackage[]>(
    `/api/admin/packages/${encodeURIComponent(network)}`,
    { auth: true },
  );
  return {
    packages: Array.isArray(res.data) ? res.data : [],
    activeProvider: typeof res.activeProvider === "string" ? res.activeProvider : "",
  };
}

export async function updateAdminPackages(
  network: string,
  packages: AdminPackage[],
): Promise<AdminPackage[]> {
  const res = await apiRequest<AdminPackage[]>(
    `/api/admin/packages/${encodeURIComponent(network)}`,
    { method: "PUT", json: { packages }, auth: true },
  );
  return Array.isArray(res.data) ? res.data : [];
}

/* --------------------------- Provider routing ---------------------------- */

export async function getProviderRouting(): Promise<ProviderRoutingData> {
  const res = await apiRequest<ProviderRoutingData>("/api/admin/provider-routing", {
    auth: true,
  });
  return {
    routing: res.data?.routing ?? {},
    updatedAt: res.data?.updatedAt ?? null,
    updatedBy: res.data?.updatedBy ?? null,
  };
}

export async function updateProviderRouting(
  routing: ProviderRouting,
): Promise<ProviderRoutingData> {
  const res = await apiRequest<ProviderRoutingData>("/api/admin/provider-routing", {
    method: "PUT",
    json: { routing },
    auth: true,
  });
  return {
    routing: res.data?.routing ?? routing,
    updatedAt: res.data?.updatedAt ?? null,
    updatedBy: res.data?.updatedBy ?? null,
  };
}

export async function getProviderHealth(): Promise<ProviderHealthData> {
  const res = await apiRequest<ProviderHealthData>("/api/admin/provider-health", {
    auth: true,
  });
  return res.data ?? {};
}

/* ---------------------------------- AFA ---------------------------------- */

/**
 * Set the AFA registration fee (GHS). Reading it back is the public
 * `getAfaFee()` in services/api.ts — there is no admin-only read.
 */
export async function updateAfaFee(fee: number): Promise<AfaFeeResult> {
  const res = await apiRequest<AfaFeeResult>("/api/admin/afa/fee", {
    method: "PUT",
    json: { fee },
    auth: true,
  });
  return res.data as AfaFeeResult;
}
