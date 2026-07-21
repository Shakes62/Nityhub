import { ImageResponse } from "next/og";

export const contentType = "image/png";

/**
 * PWA icons generated from the same mark as the favicon and apple icon.
 *
 * `spec` is "<size>" for a standard icon or "<size>-maskable" for one with the
 * safe-zone padding Android needs before applying its own mask. Generating them
 * keeps every icon in sync with the brand instead of drifting as stale binaries.
 */
const ALLOWED_SIZES = new Set([32, 192, 512]);

export async function GET(_request: Request, { params }: { params: Promise<{ spec: string }> }) {
  const { spec } = await params;
  const [rawSize, variant] = spec.split("-");
  const size = Number(rawSize);

  if (!ALLOWED_SIZES.has(size)) {
    return new Response("Not found", { status: 404 });
  }

  const maskable = variant === "maskable";
  // Android's maskable safe zone is the middle 80%; keep the glyph inside it.
  const glyph = Math.round(size * (maskable ? 0.46 : 0.62));

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
        <svg width={glyph} height={glyph} viewBox="0 0 64 64">
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
    { width: size, height: size },
  );
}
