import type { Metadata } from "next";
import type { ReactNode } from "react";
import { API_BASE } from "@/constants/config";

/**
 * Per-store title and description, so a store link shared on WhatsApp previews
 * with the reseller's own name. Cached briefly; a lookup failure just falls
 * back to generic copy rather than failing the page.
 */
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  try {
    const response = await fetch(`${API_BASE}/api/storefronts/${encodeURIComponent(slug)}`, {
      next: { revalidate: 300 },
      signal: AbortSignal.timeout(3000),
    });
    const payload = response.ok ? await response.json() : null;
    const store = payload?.data;
    if (store?.name) {
      const description = store.tagline || `Buy MTN, Telecel and AirtelTigo data from ${store.name}. Pay with Mobile Money or card, no account needed.`;
      return {
        title: store.name,
        description,
        alternates: { canonical: `/store/${slug}` },
        openGraph: { title: store.name, description, url: `/store/${slug}` },
        twitter: { title: store.name, description },
      };
    }
  } catch {
    // fall through to the generic metadata
  }
  return { title: "Data store", robots: { index: false } };
}

export default function StoreLayout({ children }: { children: ReactNode }) {
  return children;
}
