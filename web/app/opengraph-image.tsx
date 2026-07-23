import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { SITE_DESCRIPTION } from "@/constants/config";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "NityHub — Data Bundles & Wallet in Ghana";

/** Load the white brand symbol as a data URI so next/og can paint it. */
async function symbolDataUri() {
  const file = join(process.cwd(), "public", "brand", "nityhub-symbol-white.png");
  const buf = await readFile(file);
  return `data:image/png;base64,${buf.toString("base64")}`;
}

/**
 * Social preview card (Facebook, Twitter/X, Discord, WhatsApp, LinkedIn).
 *
 * Generated rather than shipped as a binary so it stays in sync with the brand.
 */
export default async function OpengraphImage() {
  const symbol = await symbolDataUri();
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "80px",
          background: "linear-gradient(135deg, #05201a 0%, #0b3b2e 55%, #00a76f 100%)",
          color: "#ffffff",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "24px" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: "96px",
              height: "96px",
              borderRadius: "22px",
              background: "#00a76f",
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={symbol} width={60} height={60} alt="" />
          </div>
          <div style={{ fontSize: "56px", fontWeight: 700, letterSpacing: "-1px" }}>NityHub</div>
        </div>

        <div
          style={{
            marginTop: "48px",
            fontSize: "64px",
            fontWeight: 700,
            lineHeight: 1.1,
            letterSpacing: "-2px",
            maxWidth: "900px",
          }}
        >
          Data bundles &amp; wallet, done properly.
        </div>

        <div
          style={{
            marginTop: "28px",
            fontSize: "30px",
            lineHeight: 1.4,
            color: "rgba(255,255,255,0.82)",
            maxWidth: "880px",
          }}
        >
          {SITE_DESCRIPTION}
        </div>

        <div style={{ marginTop: "auto", display: "flex", gap: "16px", fontSize: "26px" }}>
          {["MTN", "Telecel", "AirtelTigo"].map((label) => (
            <div
              key={label}
              style={{
                padding: "10px 22px",
                borderRadius: "999px",
                background: "rgba(255,255,255,0.14)",
                border: "1px solid rgba(255,255,255,0.22)",
              }}
            >
              {label}
            </div>
          ))}
        </div>
      </div>
    ),
    size,
  );
}
