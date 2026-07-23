import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { SITE_DESCRIPTION, SITE_URL } from "@/constants/config";

/**
 * The NityHub social preview card (1200×630), shared by the OpenGraph and
 * Twitter image routes so both platforms render the exact same artwork.
 *
 * Everything here stays inside the Satori subset next/og supports: flexbox
 * only (every multi-child box declares `display: flex`), gradients, opacity and
 * transforms — no grid, no box-shadow, no external fonts.
 */

export const OG_SIZE = { width: 1200, height: 630 };
export const OG_CONTENT_TYPE = "image/png";
export const OG_ALT = "NityHub — Buy MTN, Telecel & AirtelTigo data bundles in Ghana";

/** Bare host (no scheme) for the footer, e.g. "buy.nityhub.online". */
function siteHost(): string {
  try {
    return new URL(SITE_URL).host;
  } catch {
    return "buy.nityhub.online";
  }
}

/** Load the white brand symbol as a data URI so next/og can paint it. */
async function symbolDataUri(): Promise<string> {
  const file = join(process.cwd(), "public", "brand", "nityhub-symbol-white.png");
  const buf = await readFile(file);
  return `data:image/png;base64,${buf.toString("base64")}`;
}

const NETWORKS: { label: string; color: string }[] = [
  { label: "MTN", color: "#FFCB05" },
  { label: "Telecel", color: "#E60000" },
  { label: "AirtelTigo", color: "#3B82F6" },
];

export async function renderBrandCard(): Promise<ImageResponse> {
  const symbol = await symbolDataUri();

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          position: "relative",
          overflow: "hidden",
          padding: "68px 72px",
          background:
            "linear-gradient(135deg, #04160f 0%, #0a3226 46%, #0f5c43 100%)",
          color: "#ffffff",
          fontFamily: "sans-serif",
        }}
      >
        {/* Brand accent rail on the left edge. */}
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            bottom: 0,
            width: "12px",
            display: "flex",
            background: "linear-gradient(180deg, #00a76f 0%, #1ee0a0 100%)",
          }}
        />

        {/* Oversized watermark of the mark, bleeding off the right edge. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={symbol}
          width={640}
          height={640}
          alt=""
          style={{
            position: "absolute",
            top: "78px",
            right: "-150px",
            opacity: 0.07,
          }}
        />

        {/* Header: brand lockup. */}
        <div style={{ display: "flex", alignItems: "center", gap: "22px" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: "88px",
              height: "88px",
              borderRadius: "22px",
              background: "#00a76f",
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={symbol} width={54} height={54} alt="" />
          </div>
          <div style={{ display: "flex", fontSize: "46px", fontWeight: 700, letterSpacing: "-1px" }}>
            NityHub
          </div>
        </div>

        {/* Middle: eyebrow + headline + description. */}
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{
              display: "flex",
              fontSize: "24px",
              fontWeight: 600,
              letterSpacing: "6px",
              color: "#4be3ad",
            }}
          >
            GHANA · DATA &amp; WALLET
          </div>
          <div
            style={{
              display: "flex",
              marginTop: "22px",
              fontSize: "66px",
              fontWeight: 700,
              lineHeight: 1.05,
              letterSpacing: "-2px",
              maxWidth: "860px",
            }}
          >
            Data bundles &amp; wallet, done properly.
          </div>
          <div
            style={{
              display: "flex",
              marginTop: "26px",
              fontSize: "28px",
              lineHeight: 1.4,
              color: "rgba(255,255,255,0.82)",
              maxWidth: "820px",
            }}
          >
            {SITE_DESCRIPTION}
          </div>
        </div>

        {/* Footer: network chips (left) + domain (right). */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
            {NETWORKS.map((n) => (
              <div
                key={n.label}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "12px",
                  padding: "12px 24px",
                  borderRadius: "999px",
                  fontSize: "26px",
                  fontWeight: 500,
                  background: "rgba(255,255,255,0.10)",
                  border: "1px solid rgba(255,255,255,0.20)",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    width: "16px",
                    height: "16px",
                    borderRadius: "999px",
                    background: n.color,
                  }}
                />
                {n.label}
              </div>
            ))}
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              padding: "12px 26px",
              borderRadius: "999px",
              fontSize: "26px",
              fontWeight: 600,
              color: "#04160f",
              background: "linear-gradient(135deg, #1ee0a0 0%, #00a76f 100%)",
            }}
          >
            {siteHost()}
          </div>
        </div>
      </div>
    ),
    OG_SIZE,
  );
}
