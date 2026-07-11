import type { ReactNode } from "react";
import { AppShell } from "@/components/layout/app-shell";

/** Layout for all authenticated pages. */
export default function AppGroupLayout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
