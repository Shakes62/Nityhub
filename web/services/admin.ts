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

export interface VendingControls {
  enabled: boolean;
  networks: Record<string, "active" | "maintenance">;
  minimumMargin: number;
  /** Refuse to sell a package whose provider cost has not been recorded. */
  requireProviderCosts: boolean;
  updatedAt?: number;
}

export async function getVendingControls(): Promise<VendingControls> {
  const res = await apiRequest<VendingControls>("/api/admin/vending-controls", { auth: true });
  return res.data as VendingControls;
}

export async function updateVendingControls(value: VendingControls): Promise<VendingControls> {
  const res = await apiRequest<VendingControls>("/api/admin/vending-controls", { method: "PUT", json: value, auth: true });
  return res.data as VendingControls;
}

export async function getProviderCosts(network: string): Promise<Record<string, Record<string, number>>> {
  const res = await apiRequest<Record<string, Record<string, number>>>(`/api/admin/provider-costs/${encodeURIComponent(network)}`, { auth: true });
  return res.data ?? {};
}

export async function updateProviderCosts(network: string, costs: Record<string, Record<string, number>>): Promise<void> {
  await apiRequest(`/api/admin/provider-costs/${encodeURIComponent(network)}`, { method: "PUT", json: { costs }, auth: true });
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

/* --------------------------------- Banners -------------------------------- */

export async function getAdminBanners(): Promise<import("@/types/engagement").StoreBanner[]> {
  const res = await apiRequest<import("@/types/engagement").StoreBanner[]>("/api/admin/banners", {
    auth: true,
  });
  return Array.isArray(res.data) ? res.data : [];
}

export async function saveAdminBanner(
  banner: Partial<import("@/types/engagement").StoreBanner>,
): Promise<import("@/types/engagement").StoreBanner> {
  const res = await apiRequest<import("@/types/engagement").StoreBanner>("/api/admin/banners", {
    method: "PUT",
    json: banner,
    auth: true,
  });
  return res.data as import("@/types/engagement").StoreBanner;
}

export async function deleteAdminBanner(id: string): Promise<void> {
  await apiRequest(`/api/admin/banners/${encodeURIComponent(id)}`, {
    method: "DELETE",
    auth: true,
  });
}

/* ------------------------------- Dispatch health ------------------------------ */

export async function resetProviderDispatch(provider: string): Promise<void> {
  await apiRequest(`/api/admin/provider-health/${encodeURIComponent(provider)}/reset`, {
    method: "POST",
    auth: true,
    json: {},
  });
}

/* --------------------------------- Security -------------------------------- */

export type BlacklistKind = "phone" | "identity";

export interface RiskFlag {
  id: string;
  actor: string;
  reason: string;
  count: number;
  firstAt: number;
  lastAt: number;
  details?: Record<string, unknown>;
}

export interface SecurityOverview {
  blacklist: { phone: number; identity: number };
  riskFlags: RiskFlag[];
}

export async function getSecurityOverview(): Promise<SecurityOverview> {
  const res = await apiRequest<SecurityOverview>("/api/admin/security/overview", { auth: true });
  return res.data ?? { blacklist: { phone: 0, identity: 0 }, riskFlags: [] };
}

export async function checkBlacklist(kind: BlacklistKind, value: string): Promise<{ blocked: boolean; note: string; updatedAt: number | null }> {
  const res = await apiRequest<{ blocked: boolean; note: string; updatedAt: number | null }>(
    `/api/admin/blacklist/${kind}?value=${encodeURIComponent(value)}`,
    { auth: true },
  );
  return res.data ?? { blocked: false, note: "", updatedAt: null };
}

export async function setBlacklist(kind: BlacklistKind, value: string, active: boolean, note = ""): Promise<void> {
  await apiRequest(`/api/admin/blacklist/${kind}`, { method: "PUT", auth: true, json: { value, active, note } });
}

export async function clearRiskFlag(id: string): Promise<void> {
  await apiRequest(`/api/admin/risk-flags/${encodeURIComponent(id)}`, { method: "DELETE", auth: true });
}

/* -------------------------------- Storefronts ------------------------------- */

export interface AdminStorefront {
  slug: string;
  name: string;
  tagline: string;
  whatsapp: string;
  enabled: boolean;
  suspended: boolean;
  paused: boolean;
  customDomain: string;
  storeUrl: string;
  ownerUid: string;
  margins: Record<string, number>;
  stats: { sales: number; profit: number; revenue: number };
  createdAt: number;
}

export async function getAdminStorefronts(): Promise<AdminStorefront[]> {
  const res = await apiRequest<AdminStorefront[]>("/api/admin/storefronts", { auth: true });
  return Array.isArray(res.data) ? res.data : [];
}

export async function setStorefrontSuspended(slug: string, suspended: boolean): Promise<void> {
  await apiRequest(`/api/admin/storefronts/${encodeURIComponent(slug)}`, { method: "PATCH", auth: true, json: { suspended } });
}
