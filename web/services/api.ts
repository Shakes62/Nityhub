import { apiRequest } from "@/services/api-client";
import type {
  AfaRegistration,
  AfaRegistrationInput,
  DashboardData,
  DataPackage,
  Order,
  UserProfile,
  UserRole,
  WalletData,
} from "@/types/models";
import type { DeliveryEstimate, NetworkAvailability, UserNotification } from "@/types/engagement";

/**
 * Typed endpoint functions for the NityHub backend. Each corresponds 1:1 to an
 * Express route consumed by the original frontend; defaults match the legacy
 * common.js helpers so downstream code sees identical shapes.
 */

const limitQuery = (limit?: number) =>
  Number(limit || 0) > 0 ? `?limit=${Number(limit)}` : "";

/* ----------------------------- Reseller eStores ---------------------------- */

/** What any buyer sees. Margins are never sent to the public store. */
export interface Storefront {
  slug: string;
  name: string;
  tagline: string;
  whatsapp: string;
  enabled: boolean;
}

/** The reseller's own view of their store. */
export interface OwnStorefront extends Storefront {
  margins: Record<string, number>;
  customDomain: string;
  suspended: boolean;
  paused: boolean;
  storeUrl: string;
  stats: { sales: number; profit: number; revenue: number };
  createdAt: number;
}

export interface OwnStorefrontState {
  store: OwnStorefront | null;
  eligible: boolean;
  baseDomain: string;
}

export interface StoreSale {
  reference: string;
  status: string;
  amount: number;
  profit: number;
  network: string;
  label: string;
  createdAt: number;
  creditedAt: number | null;
}

export interface StorefrontInput {
  name: string;
  slug?: string;
  tagline: string;
  whatsapp: string;
  margins: Record<string, number>;
  customDomain: string;
  paused: boolean;
}

export async function getStorefront(slug: string): Promise<Storefront> {
  const res = await apiRequest<Storefront>(`/api/storefronts/${encodeURIComponent(slug)}`);
  return res.data as Storefront;
}

export async function getMyStorefront(): Promise<OwnStorefrontState> {
  const res = await apiRequest<OwnStorefront | null>("/api/storefront/me", { auth: true });
  return {
    store: res.data || null,
    eligible: res.eligible === true,
    baseDomain: typeof res.baseDomain === "string" ? res.baseDomain : "",
  };
}

export async function saveMyStorefront(input: StorefrontInput): Promise<OwnStorefront> {
  const res = await apiRequest<OwnStorefront>("/api/storefront/me", { method: "PUT", auth: true, json: input });
  return res.data as OwnStorefront;
}

export async function getStorePackages(slug: string, network: string): Promise<DataPackage[]> {
  const res = await apiRequest<DataPackage[]>(`/api/storefronts/${encodeURIComponent(slug)}/packages/${encodeURIComponent(network)}`);
  return Array.isArray(res.data) ? res.data : [];
}

export async function startStoreCheckout(slug: string, input: { network: string; packageId: string; phone: string; email: string }): Promise<{ reference: string; amount: number; authorization_url: string }> {
  const res = await apiRequest<{ reference: string; amount: number; authorization_url: string }>(`/api/storefronts/${encodeURIComponent(slug)}/checkout`, { method: "POST", json: input });
  return res.data as { reference: string; amount: number; authorization_url: string };
}

export async function getMyStoreSales(): Promise<StoreSale[]> {
  const res = await apiRequest<StoreSale[]>("/api/storefront/me/sales", { auth: true });
  return Array.isArray(res.data) ? res.data : [];
}

const BASELINE_ESTIMATE = { label: "Usually 5–15 min", tone: "standard" as const, measured: false, samples: 0 };

/**
 * Switchboard state plus delivery estimates. On failure this reports every
 * network as unknown-but-open rather than paused: the server re-checks at
 * checkout, and a flaky read must not blank the shop.
 */
export async function getNetworkAvailability(): Promise<NetworkAvailability> {
  const res = await apiRequest<NetworkAvailability>("/api/network-availability");
  const data = res.data;
  return {
    enabled: data?.enabled !== false,
    networks: data?.networks ?? {},
    estimates: data?.estimates ?? {},
  };
}

/** The estimate to show for a network, never empty and never "unavailable". */
export function estimateFor(availability: NetworkAvailability | null, network: string): DeliveryEstimate {
  return availability?.estimates?.[network] ?? BASELINE_ESTIMATE;
}

/* ----------------------------- Notifications ------------------------------ */

export async function getNotifications(): Promise<UserNotification[]> {
  const res = await apiRequest<UserNotification[]>("/api/me/notifications", { auth: true });
  return Array.isArray(res.data) ? res.data : [];
}

export async function markNotificationsRead(): Promise<void> {
  await apiRequest("/api/me/notifications/read", { method: "POST", auth: true, json: {} });
}

export async function registerPushToken(token: string): Promise<void> {
  await apiRequest("/api/me/push-token", { method: "POST", auth: true, json: { token } });
}

export async function unregisterPushToken(token: string): Promise<void> {
  await apiRequest("/api/me/push-token", { method: "DELETE", auth: true, json: { token } });
}

/* ----------------------------- Account / profile ----------------------------- */

export async function bootstrapAccount(input: {
  username: string;
  phone: string;
}): Promise<void> {
  await apiRequest("/api/me/bootstrap", { method: "POST", json: input, auth: true });
}

export async function getUserProfile(): Promise<UserProfile> {
  const res = await apiRequest<UserProfile>("/api/me/profile", { auth: true });
  return res.data || {};
}

export async function updateUserProfile(input: {
  username: string;
  phone: string;
}): Promise<void> {
  await apiRequest("/api/me/profile", { method: "PATCH", json: input, auth: true });
}

/**
 * The signed-in user's role. Only `admin` is exposed — it gates the admin
 * navigation. Pricing is resolved entirely server-side, so the client neither
 * receives nor needs agent status.
 */
export async function getMyRole(): Promise<UserRole> {
  const res = await apiRequest<UserRole>("/api/me/role", { auth: true });
  return { admin: res.data?.admin === true };
}

/* --------------------------------- Wallet ---------------------------------- */

export async function getWalletData(limit?: number): Promise<WalletData> {
  const res = await apiRequest<WalletData>(`/api/me/wallet${limitQuery(limit)}`, {
    auth: true,
  });
  return res.data || { balance: 0, transactions: [] };
}

export async function getWalletBalance(): Promise<number> {
  const data = await getWalletData(1);
  return Number(data.balance || 0);
}

/** POST /api/wallet/credit-deposit — confirm a Paystack deposit callback. */
export async function creditDeposit(reference: string): Promise<DepositResult> {
  const res = await apiRequest<{ amount?: number; balance?: number }>("/api/wallet/credit-deposit", {
    method: "POST",
    json: { reference },
    auth: true,
  });
  return {
    status: String(res.status || "success"),
    message: String(res.message || ""),
    amount: res.data?.amount != null ? Number(res.data.amount) : null,
    balance: res.data?.balance != null ? Number(res.data.balance) : null,
  };
}

export interface DepositResult {
  /** "success" once credited (now or earlier); "pending" while Paystack is still confirming. */
  status: string;
  message: string;
  amount: number | null;
  balance: number | null;
}

/* -------------------------------- Payments --------------------------------- */

export interface InitiatePaymentResult {
  authorization_url?: string;
  [key: string]: unknown;
}

export async function initiatePayment(input: {
  paymentType: string;
  amount: number;
}): Promise<InitiatePaymentResult> {
  const res = await apiRequest<InitiatePaymentResult>("/api/initiate-payment", {
    method: "POST",
    json: input,
    auth: true,
  });
  return res.data || {};
}

/* -------------------------------- Packages --------------------------------- */

/**
 * Bundles for a network, each already carrying the single `price` that applies
 * to this caller.
 *
 * `authOptional` matters: it lets the backend resolve the caller's price tier
 * itself. The client must not compute a price — that duplication is what
 * previously let the displayed and charged amounts diverge.
 */
export async function getPackages(network: string): Promise<DataPackage[]> {
  const res = await apiRequest<DataPackage[]>(`/api/packages/${network}`, {
    authOptional: true,
  });
  return Array.isArray(res.data) ? res.data : [];
}

/* --------------------------------- Purchase -------------------------------- */

export interface WalletPurchaseInput {
  network: string;
  phone: string;
  packageId: string;
  volume?: number;
}

export interface WalletPurchaseResult {
  reference?: string;
  orderStatus?: string;
  balance?: number | null;
  amount?: number;
  [key: string]: unknown;
}

export async function walletPurchase(input: WalletPurchaseInput) {
  return apiRequest<WalletPurchaseResult>("/api/wallet-purchase", {
    method: "POST",
    json: input,
    auth: true,
  });
}

/* --------------------------------- Orders ---------------------------------- */

export async function getUserOrders(limit?: number): Promise<Order[]> {
  const res = await apiRequest<Order[]>(`/api/me/orders${limitQuery(limit)}`, {
    auth: true,
  });
  return Array.isArray(res.data) ? res.data : [];
}

export interface RepairResult {
  reference?: string;
  orderStatus?: string;
  status?: string;
  message?: string;
}

export async function repairOrder(reference: string): Promise<{ status: string; message: string; data?: Order & RepairResult }> {
  return apiRequest<Order & RepairResult>("/api/repair-order", {
    method: "POST", json: { reference }, authOptional: true,
  }) as Promise<{ status: string; message: string; data?: Order & RepairResult }>;
}

export async function getReceipt(reference: string): Promise<Order> {
  const res = await apiRequest<Order>(`/api/receipt/${encodeURIComponent(reference)}`, { authOptional: true });
  return res.data as Order;
}

/* -------------------------------- Dashboard -------------------------------- */

export async function getDashboardData(): Promise<DashboardData> {
  const res = await apiRequest<DashboardData>("/api/me/dashboard", { auth: true });
  return res.data || {};
}

/* ----------------------------------- AFA ----------------------------------- */

export async function getAfaFee(): Promise<number> {
  const res = await apiRequest<{ fee?: number }>("/api/afa/fee");
  return Number(res.data?.fee ?? 0);
}

export async function getAfaRegistrations(limit?: number): Promise<AfaRegistration[]> {
  const res = await apiRequest<AfaRegistration[]>(
    `/api/me/afa-registrations${limitQuery(limit)}`,
    { auth: true },
  );
  return Array.isArray(res.data) ? res.data : [];
}

export async function registerAfa(input: AfaRegistrationInput): Promise<void> {
  await apiRequest("/api/afa/register", { method: "POST", json: input, auth: true });
}

/* --------------------------- Social Proof & Banners ----------------------- */

export async function getDeliveryProofs(): Promise<import("@/types/engagement").DeliveryProof[]> {
  try {
    const res = await apiRequest<import("@/types/engagement").DeliveryProof[]>("/api/social-proof/deliveries");
    return Array.isArray(res.data) ? res.data : [];
  } catch {
    return [];
  }
}

export async function getBanners(): Promise<import("@/types/engagement").StoreBanner[]> {
  try {
    const res = await apiRequest<import("@/types/engagement").StoreBanner[]>("/api/banners");
    return Array.isArray(res.data) ? res.data : [];
  } catch {
    return [];
  }
}
