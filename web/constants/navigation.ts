import {
  FileText,
  LayoutDashboard,
  ClipboardList,
  ShoppingCart,
  User,
  Wallet,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  meta: string;
  icon: LucideIcon;
}

/** Primary sidebar navigation (mirrors the original app nav order). */
export const NAV_ITEMS: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", meta: "Home", icon: LayoutDashboard },
  { href: "/buy", label: "Buy Data", meta: "Bundles", icon: ShoppingCart },
  { href: "/orders", label: "Orders", meta: "History", icon: ClipboardList },
  { href: "/wallet", label: "Wallet", meta: "Balance", icon: Wallet },
  { href: "/account", label: "Account", meta: "Profile", icon: User },
  { href: "/afa", label: "AFA", meta: "Registration", icon: FileText },
];
