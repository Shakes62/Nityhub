export interface DeliveryProof {
  id: string;
  network: "mtn" | "telecel" | "at" | string;
  networkLabel: string;
  packageLabel: string;
  durationSeconds: number;
  durationText: string;
  completedAt: number;
  completedAgoText: string;
}

export type BannerVariant = "promotion" | "operational" | "announcement";

export interface StoreBanner {
  id: string;
  variant: BannerVariant;
  title: string;
  message: string;
  actionLabel?: string | null;
  actionUrl?: string | null;
  enabled: boolean;
  priority?: number;
  startsAt?: number | null;
  endsAt?: number | null;
  createdAt?: number;
  updatedAt?: number;
}

/** Customer-facing delivery time for a network. Never "unavailable". */
export interface DeliveryEstimate {
  label: string;
  tone: "fast" | "standard";
  measured: boolean;
  samples: number;
  medianSeconds?: number;
}

export type NetworkState = "active" | "maintenance";

export interface NetworkAvailability {
  enabled: boolean;
  networks: Record<string, NetworkState>;
  estimates: Record<string, DeliveryEstimate>;
}

export interface UserNotification {
  id: string;
  type: string;
  title: string;
  message: string;
  url: string;
  amount: number | null;
  read: boolean;
  createdAt: number;
}

export interface LiveWallet {
  balance: number;
  availableBalance: number;
  heldBalance: number;
}
