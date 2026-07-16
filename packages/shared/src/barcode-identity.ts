export const BARCODE_TYPES = [
  "ean13",
  "upc",
  "isbn",
  "gtin",
  "code128",
  "custom",
] as const;

export type BarcodeType = (typeof BARCODE_TYPES)[number];

export const INTERNAL_CODE128_BARCODE_PREFIX = "99";

const FNV64_OFFSET = 14_695_981_039_346_656_037n;
const FNV64_PRIME = 1_099_511_628_211n;
const FNV64_MASK = (1n << 64n) - 1n;
const INTERNAL_CODE128_MODULUS = 1_000_000_000_000n;

/**
 * Builds the platform-owned scan identity for a newly persisted SKU. Fourteen
 * numeric digits let a Code 128 renderer use compact Code Set C, which keeps
 * the symbol reliable on common 40–50 mm labels. The stable variant id makes
 * retries deterministic; the global database identity guard rejects the
 * extremely unlikely collision with another SKU or merchant barcode.
 */
export function generateInternalCode128Barcode(variantId: string): string {
  const stableIdentity = variantId.trim();
  if (!stableIdentity) {
    throw new Error("A stable variant id is required.");
  }
  let hash = FNV64_OFFSET;
  for (let index = 0; index < stableIdentity.length; index += 1) {
    hash ^= BigInt(stableIdentity.charCodeAt(index));
    hash = (hash * FNV64_PRIME) & FNV64_MASK;
  }
  const digits = (hash % INTERNAL_CODE128_MODULUS).toString().padStart(12, "0");
  return `${INTERNAL_CODE128_BARCODE_PREFIX}${digits}`;
}

/**
 * Canonical merchant-facing barcode value. Empty and whitespace-only values
 * are represented as null so every write path can share the same absence
 * semantics.
 */
export function normalizeBarcodeValue(
  value: string | null | undefined,
): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

/**
 * Case-insensitive barcode identity used by uniqueness checks and lookups.
 * The stored/display value may preserve merchant casing; identity does not.
 */
export function getBarcodeIdentityKey(
  value: string | null | undefined,
): string | null {
  return normalizeBarcodeValue(value)?.toLocaleLowerCase("en-US") ?? null;
}

function isSupportedBarcodeType(
  value: string | null | undefined,
): value is BarcodeType {
  return BARCODE_TYPES.includes(value as BarcodeType);
}

function hasValidGtinChecksum(value: string): boolean {
  if (!/^\d+$/.test(value) || value.length < 2) return false;

  let sum = 0;
  for (let index = value.length - 2, weight = 3; index >= 0; index--, weight = weight === 3 ? 1 : 3) {
    sum += Number(value[index]) * weight;
  }

  const expectedCheckDigit = (10 - (sum % 10)) % 10;
  return expectedCheckDigit === Number(value[value.length - 1]);
}

function hasValidIsbn10Checksum(value: string): boolean {
  if (!/^\d{9}[\dXx]$/.test(value)) return false;

  const normalized = value.toUpperCase();
  let sum = 0;
  for (let index = 0; index < normalized.length; index++) {
    const digit = normalized[index] === "X" ? 10 : Number(normalized[index]);
    sum += digit * (10 - index);
  }
  return sum % 11 === 0;
}

function hasValidIsbn13Checksum(value: string): boolean {
  return /^(978|979)\d{10}$/.test(value) && hasValidGtinChecksum(value);
}

function isCode128BText(value: string): boolean {
  return [...value].every((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && codePoint >= 32 && codePoint <= 126;
  });
}

/**
 * Validates the supported product-variant barcode contract. The value is
 * normalized before validation, so surrounding whitespace is discarded while
 * significant characters such as leading zeroes are preserved.
 *
 * Returns a concise merchant-safe error, or null when the pair is valid.
 */
export function getBarcodeValidationError(
  value: string | null | undefined,
  type: BarcodeType | string | null | undefined,
): string | null {
  const barcode = normalizeBarcodeValue(value);
  const hasType = type !== null && type !== undefined && type !== "";

  if (!barcode && !hasType) return null;
  if (!barcode || !hasType) {
    return "Barcode and barcode type must be provided together.";
  }
  if (!isSupportedBarcodeType(type)) {
    return "Unsupported barcode type.";
  }

  switch (type) {
    case "ean13":
      return /^\d{13}$/.test(barcode) && hasValidGtinChecksum(barcode)
        ? null
        : "EAN-13 must be 13 digits with a valid checksum.";
    case "upc":
      return /^\d{12}$/.test(barcode) && hasValidGtinChecksum(barcode)
        ? null
        : "UPC-A must be 12 digits with a valid checksum.";
    case "gtin":
      return [8, 12, 13, 14].includes(barcode.length) &&
          hasValidGtinChecksum(barcode)
        ? null
        : "GTIN must be 8, 12, 13, or 14 digits with a valid checksum.";
    case "isbn":
      return hasValidIsbn10Checksum(barcode) || hasValidIsbn13Checksum(barcode)
        ? null
        : "ISBN must be a valid ISBN-10 or ISBN-13.";
    case "code128":
      return barcode.length <= 50 && isCode128BText(barcode)
        ? null
        : "Code 128 must be 50 printable ASCII characters or fewer.";
    case "custom":
      return barcode.length <= 50
        ? null
        : "Custom barcode must be 50 characters or fewer.";
  }
}
