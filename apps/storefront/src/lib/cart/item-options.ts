export type CartItemOption = {
  name: string;
  label: string;
};

// Product option matrices support at most five axes. Keep cart metadata bounded
// to the same contract so local storage and checkout payloads cannot grow
// without limit while still preserving every valid merchant-defined axis.
export const MAX_CART_ITEM_OPTIONS = 5;
const MAX_OPTION_NAME_LENGTH = 80;
const MAX_OPTION_LABEL_LENGTH = 160;
const MAX_VARIANT_LABEL_LENGTH = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncateUtf16(value: string, maxLength: number): string {
  const truncated = value.slice(0, maxLength);
  const lastCodeUnit = truncated.charCodeAt(truncated.length - 1);
  return lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff
    ? truncated.slice(0, -1)
    : truncated;
}

function normalizeText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127 ? " " : character;
    })
    .join("")
    .trim();
  return normalized ? truncateUtf16(normalized, maxLength) : null;
}

/**
 * Reads ordered, buyer-facing option metadata from an untrusted cart snapshot.
 * Invalid entries are ignored because product and variant IDs remain the
 * authoritative checkout identity; this metadata is display-only.
 */
export function normalizeCartItemOptions(
  value: unknown,
): CartItemOption[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const options: CartItemOption[] = [];
  const seenNames = new Set<string>();
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const name = normalizeText(entry.name, MAX_OPTION_NAME_LENGTH);
    const label = normalizeText(entry.label, MAX_OPTION_LABEL_LENGTH);
    if (!name || !label) continue;

    const normalizedName = name.toLocaleLowerCase();
    if (seenNames.has(normalizedName)) continue;
    seenNames.add(normalizedName);
    options.push({ name, label });
    if (options.length >= MAX_CART_ITEM_OPTIONS) break;
  }

  return options.length > 0 ? options : undefined;
}

export function cartItemVariantLabel(value: unknown): string | null {
  const options = normalizeCartItemOptions(value);
  if (!options) return null;
  return truncateUtf16(
    options.map((option) => option.label).join(" / "),
    MAX_VARIANT_LABEL_LENGTH,
  );
}
