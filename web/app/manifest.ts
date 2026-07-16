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
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
