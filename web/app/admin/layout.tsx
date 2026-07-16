import type { ReactNode } from "react";
import { AdminShell } from "@/components/admin/admin-shell";

/** Layout for the admin section — gates access and provides shared data. */
export default function AdminLayout({ children }: { children: ReactNode }) {
  return <AdminShell>{children}</AdminShell>;
}
