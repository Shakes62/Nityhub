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

/**
 * Typed endpoint functions for the NityHub backend. Each corresponds 1:1 to an
 * Express route consumed by the original frontend; defaults match the legacy
 * common.js helpers so downstream code sees identical shapes.
 */

const limitQuery = (limit?: number) =>
  Number(limit || 0) > 0 ? `?limit=${Number(limit)}` : "";

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

export async function getMyRole(): Promise<UserRole> {
  const res = await apiRequest<UserRole>("/api/me/role", { auth: true });
  return (
    res.data || { agent: false, admin: false, privileged: false, pricingTier: "user" }
  );
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
export async function creditDeposit(reference: string): Promise<void> {
  await apiRequest("/api/wallet/credit-deposit", {
    method: "POST",
    json: { reference },
    auth: true,
  });
}

/* -------------------------------- Payments --------------------------------- */

export interface InitiatePaymentResult {
  authorization_url?: string;
  [key: string]: unknown;
}

export async function initiatePayment(input: {
  paymentType: string;
  amount: number;
  reference: string;
}): Promise<InitiatePaymentResult> {
  const res = await apiRequest<InitiatePaymentResult>("/api/initiate-payment", {
    method: "POST",
    json: input,
    auth: true,
  });
  return res.data || {};
}

/* -------------------------------- Packages --------------------------------- */

export async function getPackages(network: string): Promise<DataPackage[]> {
  const res = await apiRequest<DataPackage[]>(`/api/packages/${network}`);
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
