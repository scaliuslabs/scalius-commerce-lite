import { ValidationError } from "../../errors";

export const MAX_DELIVERY_LOCATION_NAME_LENGTH = 120;

const INVALID_PROVIDER_NAMES = new Set([
  "lost",
  "n/a",
  "not applicable",
  "null",
  "test",
  "undefined",
  "unknown",
]);

const PATHAO_INTERNAL_ZONE_NAMES = new Set([
  "banani hq",
  "bulk merchant",
  "central fulfillment",
  "document-central",
]);

/**
 * Preserve merchant/provider spelling while removing whitespace that creates
 * visually duplicated or impossible-to-search checkout choices.
 */
export function normalizeDeliveryLocationName(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\s+/gu, " ");
}

export function normalizeRequiredDeliveryLocationName(value: unknown): string {
  const normalized = normalizeDeliveryLocationName(value);
  if (!normalized) {
    throw new ValidationError("Location name is required.");
  }
  if (normalized.length > MAX_DELIVERY_LOCATION_NAME_LENGTH) {
    throw new ValidationError(
      `Location name must be ${MAX_DELIVERY_LOCATION_NAME_LENGTH} characters or fewer.`,
    );
  }
  return normalized;
}

/**
 * Pathao's location feed occasionally contains operational routing buckets
 * alongside buyer geography. Suppress only exact, high-confidence provider
 * artifacts; broad keyword matching would hide legitimate places.
 */
export function shouldSuppressPathaoLocationName(
  value: unknown,
  type: "city" | "zone" | "area",
): boolean {
  const normalized = normalizeDeliveryLocationName(value);
  if (!normalized) return true;

  const key = normalized.toLocaleLowerCase("en-US");
  if (INVALID_PROVIDER_NAMES.has(key)) return true;
  if (type !== "zone") return false;

  return (
    PATHAO_INTERNAL_ZONE_NAMES.has(key) ||
    key === "on-demand" ||
    key.startsWith("on-demand-") ||
    key === "on-demand transfer" ||
    key.startsWith("pathao central ")
  );
}
