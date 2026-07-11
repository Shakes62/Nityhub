/** Domain models mirroring the shapes returned by the NityHub backend. */

/** GET /api/me/role */
export interface UserRole {
  agent: boolean;
  admin: boolean;
  privileged: boolean;
  pricingTier: "user" | "agent" | string;
}

/** GET /api/me/profile */
export interface UserProfile {
  username?: string;
  email?: string;
  phone?: string;
  createdAt?: number;
}

/** GET /api/packages/:network — a single bundle option. */
export interface DataPackage {
  id: string;
  label: string;
  volume?: number;
  userPrice?: number;
  agentPrice?: number;
  enabled?: boolean;
  sortOrder?: number;
  /** Resolved display price after applying the user's pricing tier. */
  price?: number;
}

/** GET /api/me/wallet — a single ledger entry. */
export interface WalletTransaction {
  amount?: number;
  type?: string;
  balance?: number;
  timestamp?: number;
  reference?: string;
  details?: { reference?: string } & Record<string, unknown>;
}

/** GET /api/me/wallet */
export interface WalletData {
  balance: number;
  transactions: WalletTransaction[];
}

/** GET /api/me/orders — a single order/purchase record. */
export interface Order {
  reference?: string;
  network?: string;
  phone?: string;
  volume?: number;
  label?: string;
  amount?: number;
  status?: string;
  timestamp?: number;
  createdAt?: number;
}

/** GET /api/me/dashboard */
export interface DashboardData {
  balance?: number;
  todayOrders?: number;
  todaySales?: number;
  ordersCount?: number;
  totalSales?: number;
}

/** GET /api/me/afa-registrations — a single AFA record. */
export interface AfaRegistration {
  fullname?: string;
  phone?: string;
  location?: string;
  fee?: number;
  timestamp?: number;
}

/** POST /api/afa/register payload. */
export interface AfaRegistrationInput {
  fullname: string;
  phone: string;
  dob: string;
  ghanaCard: string;
  location: string;
}
