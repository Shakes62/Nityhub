import type { Metadata, Viewport } from "next";
import { Poppins, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import { SITE_DESCRIPTION, SITE_URL } from "@/constants/config";

const SITE_TITLE = "NityHub — Data Bundles & Wallet in Ghana";

const poppins = Poppins({
  variable: "--font-poppins",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  applicationName: "NityHub",
  title: {
    default: SITE_TITLE,
    template: "%s · NityHub",
  },
  description: SITE_DESCRIPTION,
  keywords: [
    "NityHub",
    "buy data bundles Ghana",
    "MTN data bundles",
    "Telecel data",
    "AirtelTigo data",
    "cheap data Ghana",
    "internet bundles",
    "mobile data",
    "wallet funding",
    "data reseller",
    "AFA registration",
  ],
  authors: [{ name: "NityHub", url: SITE_URL }],
  creator: "NityHub",
  publisher: "NityHub",
  category: "finance",
  alternates: { canonical: "/" },
  formatDetection: { telephone: false, email: false, address: false },
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/icon-192.png", type: "image/png", sizes: "192x192" },
      { url: "/icon-512.png", type: "image/png", sizes: "512x512" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
    shortcut: ["/favicon.ico"],
  },
  appleWebApp: { capable: true, title: "NityHub", statusBarStyle: "default" },
  openGraph: {
    type: "website",
    siteName: "NityHub",
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    url: "/",
    locale: "en_GH",
    images: [{ url: "/Fullnityhub.png", width: 1536, height: 1024, alt: "NityHub" }],
  },
  twitter: {
    card: "summary_large_image",
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    images: ["/Fullnityhub.png"],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
      "max-video-preview": -1,
    },
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#00a76f",
  colorScheme: "light",
};

/** JSON-LD structured data (Organization + WebSite + WebApplication). */
const STRUCTURED_DATA = [
  {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "NityHub",
    url: SITE_URL,
    logo: `${SITE_URL}/icon-512.png`,
    description: SITE_DESCRIPTION,
  },
  {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "NityHub",
    url: SITE_URL,
  },
  {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    name: "NityHub",
    url: SITE_URL,
    applicationCategory: "FinanceApplication",
    operatingSystem: "Web, Android, iOS",
    offers: { "@type": "Offer", price: "0", priceCurrency: "GHS" },
    description: SITE_DESCRIPTION,
  },
];

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${poppins.variable} ${plexMono.variable} h-full`}>
      <body className="min-h-full antialiased">
        <script
          type="application/ld+json"
          // Static, build-time constant — safe to inline for rich results.
          dangerouslySetInnerHTML={{ __html: JSON.stringify(STRUCTURED_DATA) }}
        />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
