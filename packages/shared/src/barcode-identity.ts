export const BARCODE_TYPES = [
  "ean13",
  "upc",
  "isbn",
  "gtin",
  "custom",
] as const;

export type BarcodeType = (typeof BARCODE_TYPES)[number];

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
    case "custom":
      return barcode.length <= 50
        ? null
        : "Custom barcode must be 50 characters or fewer.";
  }
}
