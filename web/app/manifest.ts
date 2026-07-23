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
      // Exported from the NityHub brand mark (see public/brand/*) so PWA icons
      // stay in sync with the favicon and apple icon.
      { src: "/brand/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/brand/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/brand/icon-192-maskable.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/brand/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
