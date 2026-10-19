/**
 * Browser side of the billing address (components/checkout/
 * BillingAddressFields.astro): the billing country's rules, read once per
 * country, hide the fields a billing address of its mode does not use and
 * mark the required ones. The form already works without this.
 */
import type { AddressRules } from "@scalius/shared/address";
import { billingAddressFields, type BillingAddressMode } from "@scalius/shared/billing-address";
import { applyAddressRules, loadAddressRules } from "./country-address";

const COUNTRY = /^[A-Z]{2}$/;

/** A country's rules as a billing address of a mode uses them: a minimal one only its required region and postal code. */
export function billingRules(rules: AddressRules, mode: BillingAddressMode): AddressRules {
  const fields = billingAddressFields(rules, mode);
  return {
    ...rules,
    allowedFields: fields,
    requiredFields: rules.requiredFields.filter((field) => fields.includes(field)),
  };
}

/**
 * Applies the billing country's rules to the billing block (browser only):
 * on load, when the country changes, and when the cart's path changes the
 * mode (`readMode`). The form already works without this.
 */
export function enhanceBillingAddress(
  root: ParentNode,
  options: { readMode: () => BillingAddressMode; signal?: AbortSignal },
): {
  refresh(): void;
  readCountry(): string | null;
  /** The chosen country's rules, once loaded (null until then): the fields are checked with them. */
  readRules(): AddressRules | null;
} | null {
  const block = root.querySelector<HTMLElement>("[data-billing-fields]");
  if (!block) return null;
  let applied: AddressRules | null = null;
  const readCountry = () => {
    const control = root.querySelector<HTMLInputElement | HTMLSelectElement>('[name="billingCountryCode"]');
    const value = control?.value.trim().toUpperCase() ?? "";
    return COUNTRY.test(value) ? value : null;
  };
  const refresh = () => {
    const country = readCountry();
    if (!country) return;
    const mode = options.readMode();
    void loadAddressRules(country).then((rules) => {
      // The buyer may have moved on while the rules loaded.
      if (rules && readCountry() === country && options.readMode() === mode) {
        applied = rules;
        applyAddressRules(block, billingRules(rules, mode));
      }
    });
  };
  root.querySelector<HTMLSelectElement>("select[data-billing-country]")
    ?.addEventListener("change", refresh, { signal: options.signal });
  refresh();
  return {
    refresh,
    readCountry,
    readRules: () => (applied && applied.countryCode === readCountry() ? applied : null),
  };
}
