/**
 * Admin-panel domain models. These mirror the shapes returned by the
 * `/api/admin/*` endpoints on the NityHub backend (see NityHub/src/routes.js
 * and domain.js — getAdminOverviewData, provider routing/health, catalog).
 */

/** A user row from GET /api/admin/overview. */
export interface AdminUser {
  id: string;
  uid: string;
  username?: string;
  email?: string;
  phone?: string;
  isagent: boolean;
  isadmin: boolean;
  createdAt?: number;
  updatedAt?: number;
  [key: string]: unknown;
}

/** Wallet summary keyed by uid in the overview `walletsMap`. */
export interface WalletSummary {
  balance: number;
  updatedAt?: number | null;
}

/** An order row from the admin overview (richer than the user-facing Order). */
export interface AdminOrder {
  id: string;
  userId: string;
  reference?: string;
  network?: string;
  provider?: string;
  phone?: string;
  volume?: number;
  label?: string;
  amount?: number;
  status?: string;
  providerStatusRaw?: string;
  providerStatusDescription?: string;
  paymentStatus?: string;
  packageId?: string;
  timestamp?: number;
  createdAt?: number;
  updatedAt?: number;
}

/** A wallet/ledger transaction row from the admin overview. */
export interface AdminTransaction {
  id: string;
  userId?: string;
  type?: string;
  amount: number;
  balance: number;
  timestamp?: number;
  reference?: string;
  mutationId?: string;
  details?: Record<string, unknown>;
  [key: string]: unknown;
}

/** An AFA registration row from the admin overview. */
export interface AdminAfaRegistration {
  id: string;
  userId?: string;
  fullname?: string;
  phone?: string;
  dob?: string;
  ghanaCard?: string;
  location?: string;
  fee?: number;
  status?: string;
  timestamp?: number;
  [key: string]: unknown;
}

/** GET /api/admin/overview — the whole dataset in one payload. */
export interface AdminOverview {
  users: AdminUser[];
  walletsMap: Record<string, WalletSummary>;
  orders: AdminOrder[];
  transactions: AdminTransaction[];
  afa: AdminAfaRegistration[];
}

/** A package/catalog row (admin view — includes provider mappings). */
export interface AdminPackage {
  id: string;
  label?: string;
  volume?: number;
  userPrice?: number;
  agentPrice?: number;
  enabled?: boolean;
  sortOrder?: number;
  updatedAt?: number;
  updatedBy?: string;
  providerMappings?: Record<string, unknown>;
  /**
   * Required mapping fields this package leaves blank for the network's active
   * provider, computed by the backend (read-only — never sent back on save).
   * Empty means the row will pass the save/routing validation.
   */
  mappingMissing?: string[];
  [key: string]: unknown;
}

/** One field a provider needs in a package's `providerMappings`. */
export interface ProviderMappingField {
  key: string;
  label: string;
  hint: string;
}

/**
 * Labels for the mapping editor. The backend is the authority on whether a
 * mapping is complete (it returns `mappingMissing`); this map only decides
 * which inputs to render and what to call them.
 */
export const PROVIDER_MAPPING_FIELDS: Record<string, ProviderMappingField[]> = {
  hubnet: [{ key: "network", label: "Network", hint: "Hubnet network slug — mtn, at or telecel" }],
  godsway: [
    { key: "networkKey", label: "Network key", hint: "CK-Godsway network code — YELLO for MTN, TELECEL for Telecel" },
    { key: "capacity", label: "Capacity (GB)", hint: "Bundle size in GB, e.g. 1 or 1.5" },
  ],
  gigshub: [{ key: "packageId", label: "Package ID", hint: "The GiGSHUB plan id for this bundle" }],
};

/** GET /api/admin/packages/:network */
export interface AdminCatalogResult {
  packages: AdminPackage[];
  activeProvider: string;
}

/** Network → provider routing map. */
export type ProviderRouting = Record<string, string>;

/** GET /api/admin/provider-routing */
export interface ProviderRoutingData {
  routing: ProviderRouting;
  updatedAt?: number | null;
  updatedBy?: string | null;
}

/** GET /api/admin/provider-health (rendered generically). */
export interface ProviderHealthData {
  routing?: ProviderRouting;
  sync?: Record<string, unknown>;
  syncState?: Record<string, unknown>;
  providers?: Record<string, Record<string, unknown>>;
  timestamp?: string;
  [key: string]: unknown;
}

/** Result of a single manual order-status change. */
export interface OrderStatusResult {
  reference: string;
  /** False when the order was already in the requested status (no write). */
  changed: boolean;
  previousStatus: string;
  status: string;
  provider?: string;
  userId?: string;
}

/** One order that could not be updated during a bulk run. */
export interface BulkStatusFailure {
  reference: string;
  message: string;
}

/** Result of the bulk order-status update. */
export interface BulkStatusResult {
  matched: number;
  updated: number;
  /** Orders that already had the target status, so nothing was written. */
  skipped: number;
  /** Which selector was used: an explicit reference list or a date range. */
  mode: "references" | "date_range";
  currentStatus: string;
  nextStatus: string;
  byProvider?: Record<string, number>;
  references?: string[];
  failures: BulkStatusFailure[];
}

/** PUT /api/admin/afa/fee — `changed` is false when the fee was already set. */
export interface AfaFeeResult {
  fee: number;
  previous: number;
  changed: boolean;
}

/** Networks supported by the catalog/routing endpoints. */
export const ADMIN_NETWORKS = ["mtn", "at", "telecel"] as const;
export type AdminNetwork = (typeof ADMIN_NETWORKS)[number];

/** Data providers the backend can route to. */
export const ADMIN_PROVIDERS = ["hubnet", "godsway", "gigshub"] as const;
export type AdminProvider = (typeof ADMIN_PROVIDERS)[number];

/** Canonical internal order statuses (from domain.normalizeInternalOrderStatus). */
export const ORDER_STATUSES = [
  "pending",
  "accepted",
  "processing",
  "delivered",
  "failed",
  "cancelled",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
