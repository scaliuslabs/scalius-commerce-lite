// A merchant's own order source, made into the stored slug. Apart from
// order-channel.ts: the slug needs the Bangla transliteration tables
// (handle.ts), which the dashboard's every page would otherwise download with
// the channel names.
import { toHandle } from "./handle";
import { ORDER_CHANNEL_SOURCE_MAX_LENGTH } from "./order-channel";

/**
 * Normalizes a free-text source label to the stored slug: Bangla is
 * transliterated ("ফেসবুক পেজ" → "fesbuk_pej"), Latin accents are folded,
 * everything else becomes a single `_`, and the result is at most 64
 * characters. Returns null when nothing readable is left.
 */
export function normalizeOrderChannelSource(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const slug = toHandle(value)
    .replace(/-/g, "_")
    .slice(0, ORDER_CHANNEL_SOURCE_MAX_LENGTH)
    .replace(/_+$/, "");
  return slug.length > 0 ? slug : null;
}

