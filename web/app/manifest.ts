import type { MetadataRoute } from "next";
import { SITE_DESCRIPTION } from "@/constants/config";

/** PWA manifest (served at /manifest.webmanifest and auto-linked by Next). */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "NityHub — Data Bundles & Wallet",
    short_name: "NityHub",
    description: SITE_DESCRIPTION,
    start_url: "/dashboard",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#f5f7f6",
    theme_color: "#00a76f",
    categories: ["finance", "utilities", "shopping"],
    icons: [
      // Generated from the shared brand mark (see app/pwa-icon/[spec]/route.tsx)
      // so PWA icons never drift from the favicon and apple icon.
      { src: "/pwa-icon/192", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/pwa-icon/512", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/pwa-icon/192-maskable", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/pwa-icon/512-maskable", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
