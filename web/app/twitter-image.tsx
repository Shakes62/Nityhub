import { OG_ALT, OG_CONTENT_TYPE, OG_SIZE, renderBrandCard } from "@/lib/og-card";

export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const alt = OG_ALT;

/** Twitter/X large-summary card — identical artwork to the OpenGraph image. */
export default function TwitterImage() {
  return renderBrandCard();
}
