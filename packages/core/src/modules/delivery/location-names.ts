import { ValidationError } from "../../errors";

export const MAX_DELIVERY_LOCATION_NAME_LENGTH = 120;

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
