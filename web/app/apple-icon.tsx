import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

/**
 * Apple touch icon, generated from the same mark as the SVG favicon so every
 * surface shares one visual language. iOS applies its own mask, so the badge
 * fills the full canvas rather than carrying its own rounded corners.
 */
export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#00a76f",
        }}
      >
        <svg width="120" height="120" viewBox="0 0 64 64">
          <path
            d="M20 46V18l24 28V18"
            fill="none"
            stroke="#ffffff"
            strokeWidth="7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
    ),
    size,
  );
}
