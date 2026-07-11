export const STOREFRONT_COMPUTER_ACCESSIBLE_NAME_MAX_CHARS = 160;

const PRODUCT_IDENTITY_MAX_CHARS = 48;
// Persisted variant IDs are `var_` plus nanoid's 21-character default.
const VARIANT_IDENTITY_MAX_CHARS = 48;
const OPTIONS_IDENTITY_MAX_CHARS = 38;

type AddToCartOptionIdentity = {
  name: string;
  label: string;
};

export function buildStorefrontComputerAddToCartLabel(input: {
  productName: string;
  variantId: string;
  options?: readonly AddToCartOptionIdentity[];
}): string {
  const productName = boundedIdentity(
    input.productName,
    PRODUCT_IDENTITY_MAX_CHARS,
    "product",
  );
  const variantId = boundedIdentity(
    input.variantId,
    VARIANT_IDENTITY_MAX_CHARS,
    "unknown variant",
  );
  const options = boundedIdentity(
    (input.options ?? [])
      .map((option) => `${option.name} ${option.label}`)
      .join(", "),
    OPTIONS_IDENTITY_MAX_CHARS,
    "",
  );
  const label = `Add ${productName}, variant ${variantId}${
    options ? `, ${options}` : ""
  } to cart`;
  if (label.length > STOREFRONT_COMPUTER_ACCESSIBLE_NAME_MAX_CHARS) {
    throw new Error("Storefront Add to Cart label exceeded its fixed budget");
  }
  return label;
}

function boundedIdentity(
  value: string,
  maxChars: number,
  fallback: string,
): string {
  const normalized = value.replace(/\s+/gu, " ").trim() || fallback;
  if (normalized.length <= maxChars) return normalized;
  const digest = identityDigest(normalized);
  return `${normalized.slice(0, maxChars - digest.length - 2).trimEnd()}…#${digest}`;
}

function identityDigest(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
