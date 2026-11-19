/** Domain models mirroring the shapes returned by the NityHub backend. */

/**
 * GET /api/me/role
 *
 * Only `admin` is exposed, to gate the admin navigation. Agent status is
 * intentionally NOT sent to the browser: agent pricing is applied server-side
 * and must stay invisible to the customer.
 */
export interface UserRole {
  admin: boolean;
}

/** GET /api/me/profile */
export interface UserProfile {
  username?: string;
  email?: string;
  phone?: string;
  createdAt?: number;
}

/**
 * GET /api/packages/:network — a single bundle option.
 *
 * `price` is the only price the client ever sees: the backend has already
 * applied the caller's tier. `userPrice`/`agentPrice` are deliberately absent so
 * the browser cannot pick a tier (it used to, and drifted from the server) and
 * so wholesale rates are not exposed on a public endpoint.
 */
export interface DataPackage {
  id: string;
  label: string;
  volume?: number;
  enabled?: boolean;
  sortOrder?: number;
  /** Server-resolved price for the current caller, in GHS. */
  price: number;
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
  statusDescription?: string;
  isGuest?: boolean;
  storefrontSlug?: string;
  paymentStatus?: string;
  timestamp?: number;
  createdAt?: number;
  updatedAt?: number;
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
