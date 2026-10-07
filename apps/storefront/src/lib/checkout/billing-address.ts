/**
 * The billing address at checkout (migration 0119, Shopify's rule;
 * `@scalius/shared/billing-address`). An order that ships is billed at its
 * delivery address; checkout asks for a separate one only when the merchant
 * requires a full billing address. An order with nothing to ship asks for one:
 * by default only its country, plus the region and postal code the country's
 * rules require (what tax regions match on). The form
 * (components/checkout/BillingAddressFields.astro) works without JavaScript;
 * with it, the country's rules hide the fields it does not use.
 */
import { billingAddressNeed } from "@scalius/shared/billing-address";
import type { CheckoutDeliveryMode } from "./delivery-mode";

/** The billing form fields, in form order, and the canonical field each fills. */
export const BILLING_ADDRESS_FIELDS = [
  "billingName",
  "billingCompany",
  "billingAddress",
  "billingAddressLine2",
  "billingDependentLocality",
  "billingLocality",
  "billingAdminArea",
  "billingPostalCode",
] as const;
export type BillingAddressField = (typeof BILLING_ADDRESS_FIELDS)[number];

export const BILLING_FIELD_RULE: Readonly<Record<BillingAddressField, string>> = {
  billingName: "name",
  billingCompany: "company",
  billingAddress: "line1",
  billingAddressLine2: "line2",
  billingDependentLocality: "dependentLocality",
  billingLocality: "locality",
  billingAdminArea: "adminArea",
  billingPostalCode: "postalCode",
};

/** The fields a minimal billing address may send (what tax regions match on). */
export const MINIMAL_BILLING_FIELDS: readonly BillingAddressField[] = ["billingAdminArea", "billingPostalCode"];

const COUNTRY = /^[A-Z]{2}$/;

const text = (value: unknown, max = 500): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\s+/g, " ").trim().slice(0, max);
  return trimmed ? trimmed : null;
};

/** What a checkout or quote sends for the billing address: only what checkout asked for. */
export interface CheckoutBillingFields {
  billingSameAsShipping?: boolean;
  billingCountryCode?: string;
  billingName?: string | null;
  billingCompany?: string | null;
  billingAddress?: string | null;
  billingAddressLine2?: string | null;
  billingDependentLocality?: string | null;
  billingLocality?: string | null;
  billingAdminArea?: string | null;
  billingPostalCode?: string | null;
}

/**
 * The billing fields an order sends from the form's values (Shopify's rule):
 * nothing when checkout did not ask; "same as shipping" when a shipped order
 * kept the box ticked; otherwise the country and the fields of its mode.
 * `billingSameAsShipping` is the checkbox value (`"1"` when ticked).
 */
export function checkoutBillingFields(
  mode: CheckoutDeliveryMode,
  requireFullBillingAddress: boolean,
  values: Partial<Record<BillingAddressField | "billingCountryCode" | "billingSameAsShipping", unknown>>,
): CheckoutBillingFields {
  const need = billingAddressNeed({ path: mode, requireFullBillingAddress });
  if (!need.asked) return {};
  const ticked = values.billingSameAsShipping === true || values.billingSameAsShipping === "1" || values.billingSameAsShipping === "on";
  if (need.sameAsShippingOffered && ticked) return { billingSameAsShipping: true };
  const country = typeof values.billingCountryCode === "string" ? values.billingCountryCode.trim().toUpperCase() : "";
  const fields: CheckoutBillingFields = need.sameAsShippingOffered ? { billingSameAsShipping: false } : {};
  if (COUNTRY.test(country)) fields.billingCountryCode = country;
  const sent = need.mode === "minimal" ? MINIMAL_BILLING_FIELDS : BILLING_ADDRESS_FIELDS;
  for (const field of sent) {
    const value = text(values[field], field === "billingAddress" ? 500 : 200);
    if (value) fields[field] = value;
  }
  return fields;
}

/**
 * Where the tax quote locates a cart with nothing physical: its billing
 * country, region and postal code (a delivery is taxed at its address, a
 * pickup at the store).
 */
export function billingQuoteFields(
  mode: CheckoutDeliveryMode,
  values: Partial<Record<"billingCountryCode" | "billingAdminArea" | "billingPostalCode", unknown>>,
): { billingCountryCode?: string; billingAdminArea?: string; billingPostalCode?: string } {
  if (mode !== "none") return {};
  const country = typeof values.billingCountryCode === "string" ? values.billingCountryCode.trim().toUpperCase() : "";
  if (!COUNTRY.test(country)) return {};
  const adminArea = text(values.billingAdminArea, 120);
  const postalCode = text(values.billingPostalCode, 20);
  return {
    billingCountryCode: country,
    ...(adminArea ? { billingAdminArea: adminArea } : {}),
    ...(postalCode ? { billingPostalCode: postalCode } : {}),
  };
}

/**
 * The billing fields of a stored checkout (the cart page already kept only
 * what checkout asked for: `checkoutBillingFields`), as the order sends them.
 */
export function storedCheckoutBillingFields(data: Record<string, unknown>): CheckoutBillingFields {
  const fields: CheckoutBillingFields = {};
  if (data.billingSameAsShipping === true || data.billingSameAsShipping === "true") fields.billingSameAsShipping = true;
  if (data.billingSameAsShipping === false || data.billingSameAsShipping === "false") fields.billingSameAsShipping = false;
  const country = typeof data.billingCountryCode === "string" ? data.billingCountryCode.trim().toUpperCase() : "";
  if (COUNTRY.test(country)) fields.billingCountryCode = country;
  for (const field of BILLING_ADDRESS_FIELDS) {
    const value = text(data[field], field === "billingAddress" ? 500 : 200);
    if (value) fields[field] = value;
  }
  return fields;
}
