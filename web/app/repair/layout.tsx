import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Track & repair an order",
  description: "Check a delayed or interrupted data order with its reference and finish delivery safely, without being charged twice.",
  alternates: { canonical: "/repair" },
};

export default function RepairLayout({ children }: { children: ReactNode }) {
  return children;
}
