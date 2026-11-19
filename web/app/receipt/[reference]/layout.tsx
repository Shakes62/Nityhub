import type { Metadata } from "next";
import type { ReactNode } from "react";

// A receipt link is a private tracking capability: never index or cache it.
export const metadata: Metadata = {
  title: "Order receipt",
  robots: { index: false, follow: false },
};

export default function ReceiptLayout({ children }: { children: ReactNode }) {
  return children;
}
