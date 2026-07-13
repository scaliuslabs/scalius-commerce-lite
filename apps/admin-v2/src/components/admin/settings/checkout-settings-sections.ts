export const CHECKOUT_SETTINGS_SECTIONS = [
  "checkout-flow",
  "payment",
  "languages",
  "shipping",
  "delivery",
  "customer-requests",
] as const;

export type CheckoutSettingsSection =
  (typeof CHECKOUT_SETTINGS_SECTIONS)[number];

export const DEFAULT_CHECKOUT_SETTINGS_SECTION: CheckoutSettingsSection =
  "checkout-flow";

export function normalizeCheckoutSettingsSection(
  value: unknown,
): CheckoutSettingsSection {
  return typeof value === "string" &&
    CHECKOUT_SETTINGS_SECTIONS.includes(value as CheckoutSettingsSection)
    ? (value as CheckoutSettingsSection)
    : DEFAULT_CHECKOUT_SETTINGS_SECTION;
}
