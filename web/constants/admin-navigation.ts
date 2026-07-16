import {
  Boxes,
  ClipboardList,
  FileText,
  LayoutDashboard,
  Receipt,
  Users,
  type LucideIcon,
} from "lucide-react";

export interface AdminNavItem {
  href: string;
  label: string;
  meta: string;
  icon: LucideIcon;
}

/** Admin panel navigation — one route per capability (pages, not sections). */
export const ADMIN_NAV_ITEMS: AdminNavItem[] = [
  { href: "/admin", label: "Overview", meta: "Summary", icon: LayoutDashboard },
  { href: "/admin/users", label: "Users", meta: "Accounts", icon: Users },
  { href: "/admin/orders", label: "Orders", meta: "Fulfilment", icon: ClipboardList },
  { href: "/admin/transactions", label: "Transactions", meta: "Ledger", icon: Receipt },
  { href: "/admin/afa", label: "AFA", meta: "Registrations", icon: FileText },
  { href: "/admin/catalog", label: "Catalog", meta: "Packages", icon: Boxes },
];
