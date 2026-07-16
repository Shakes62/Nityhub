import type { MetadataRoute } from "next";
import { SITE_URL } from "@/constants/config";

/**
 * robots.txt — index public marketing surfaces, keep authenticated/admin app
 * areas out of search results (they require login and hold personal data).
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/admin", "/account", "/wallet", "/orders", "/afa", "/api/"],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
