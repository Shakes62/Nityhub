/** Data networks supported on the Buy page (matches the original buy.html). */
export interface NetworkOption {
  value: string;
  label: string;
}

export const NETWORKS: NetworkOption[] = [
  { value: "mtn", label: "MTN" },
  { value: "at", label: "AirtelTigo" },
  { value: "telecel", label: "Telecel" },
];
