/**
 * Billing addresses (MARKETS-DESIGN D7, migration 0119), Shopify's rule. One
 * browser-safe module for checkout, the API, agents and the dashboard.
 *
 * - An order that ships uses its shipping address as the billing address by
 *   default ("Billing address same as shipping"). Checkout asks for a
 *   separate one only when the merchant requires a full billing address.
 * - An order that ships nothing (only digital, service or gift-card lines)
 *   has no shipping address, so checkout asks for a billing address. By
 *   default it is minimal: the country, plus the admin area and the postal
 *   code when the country's rules require them (what tax regions match on).
 * - A pickup order is taxed at the store; checkout asks for a billing
 *   address only when the merchant requires a full one.
 * - "Require full billing address" (Settings → Checkout, off by default)
 *   asks every order for a full billing address, by the country's rules.
 */
import type { AddressField, AddressRules } from "./address";

/** How much of a billing address checkout asks for. */
export type BillingAddressMode = "minimal" | "full";

/** The checkout path: something ships, it is picked up, or nothing physical. */
export type BillingCheckoutPath = "delivery" | "pickup" | "none";

export interface BillingAddressNeed {
  /** Checkout shows the billing address section. */
  asked: boolean;
  /** "Same as shipping address" is offered and on by default (the order ships). */
  sameAsShippingOffered: boolean;
  mode: BillingAddressMode;
}

/** When checkout asks for a billing address, and how much of it. */
export function billingAddressNeed(input: {
  path: BillingCheckoutPath;
  requireFullBillingAddress: boolean;
}): BillingAddressNeed {
  const full = input.requireFullBillingAddress === true;
  if (input.path === "none") return { asked: true, sameAsShippingOffered: false, mode: full ? "full" : "minimal" };
  return { asked: full, sameAsShippingOffered: input.path === "delivery", mode: "full" };
}

/** Fields a minimal billing address never keeps: only its country and what tax regions match on. */
export const MINIMAL_BILLING_IGNORED_FIELDS: readonly AddressField[] = [
  "name",
  "company",
  "line1",
  "line2",
  "dependentLocality",
  "locality",
];

/**
 * The fields a billing address of a mode shows in a country, in the
 * country's form order: a minimal one only the admin area and the postal
 * code its rules require; a full one every field its rules allow.
 */
export function billingAddressFields(
  rules: Pick<AddressRules, "allowedFields" | "requiredFields" | "rows">,
  mode: BillingAddressMode,
): AddressField[] {
  const ordered = rules.rows.flat();
  if (mode === "full") return ordered.filter((field) => rules.allowedFields.includes(field));
  return ordered.filter((field) =>
    (field === "adminArea" || field === "postalCode") && rules.requiredFields.includes(field));
}

/** `details.reason` when an order that needs a billing address has none. */
export const BILLING_ADDRESS_REQUIRED_REASON = "billing_address_required";
/** `details.reason` when a billing address breaks its country's rules (`details.issues`). */
export const BILLING_ADDRESS_INVALID_REASON = "billing_address_invalid";
/** `details.reason` when no active market sells to the billing country. */
export const BILLING_COUNTRY_UNAVAILABLE_REASON = "billing_country_unavailable";
