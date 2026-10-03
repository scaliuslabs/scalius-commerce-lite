/**
 * Browser side of the address country (components/checkout/
 * ShippingCountryField.astro and ForeignAddressFields.astro): when the buyer
 * picks another country, its rules (read once per country from the public,
 * cached `/address-rules/{countryCode}`) hide the fields it doesn't use, mark
 * the ones it requires, show a postal code example and offer its regions.
 * The form already works without this; the API checks every address.
 */
import type { AddressRules } from "@scalius/shared/address";
import { getApiV1AddressRulesByCountryCode } from "@scalius/api-client/sdk";
import { getConfiguredSdkClient } from "@/lib/api/transport";
import { unwrapData } from "@/lib/api/unwrap";
import { LOCATION_COUNTRY, shippingCountryOf } from "./shipping-country";

const rulesByCountry = new Map<string, Promise<AddressRules | null>>();

/** One country's rules, read once per page; null when they can't be read (the fields stay as they are). */
export function loadAddressRules(countryCode: string): Promise<AddressRules | null> {
  let pending = rulesByCountry.get(countryCode);
  if (!pending) {
    pending = getApiV1AddressRulesByCountryCode({ client: getConfiguredSdkClient(), path: { countryCode } })
      .then(({ data }) => unwrapData<AddressRules>(data) ?? null)
      .catch(() => null);
    rulesByCountry.set(countryCode, pending);
  }
  return pending;
}

/** The country the form posts: its select or hidden field, else Bangladesh. */
export function readShippingCountry(root: ParentNode): string {
  const control = root.querySelector<HTMLInputElement | HTMLSelectElement>('[name="shippingCountryCode"]');
  return shippingCountryOf(control?.value);
}

/** Shows a country's fields as its rules describe them. */
export function applyAddressRules(block: HTMLElement, rules: AddressRules): void {
  const allowed = new Set<string>(rules.allowedFields);
  const required = new Set<string>(rules.requiredFields);
  for (const wrapper of block.querySelectorAll<HTMLElement>("[data-address-rule]")) {
    const rule = wrapper.dataset.addressRule ?? "";
    wrapper.hidden = !allowed.has(rule);
    const input = wrapper.querySelector<HTMLInputElement>("input");
    wrapper.querySelector<HTMLElement>("[data-required-mark]")?.classList.toggle("hidden", !required.has(rule));
    if (!input) continue;
    if (required.has(rule)) input.setAttribute("aria-required", "true");
    else input.removeAttribute("aria-required");
    if (rule === "postalCode") input.placeholder = rules.postalCodeExamples[0] ?? "";
    if (rule === "adminArea" && input.list) {
      input.list.replaceChildren(...rules.adminAreas.map((area) => {
        const option = document.createElement("option");
        option.value = area.name;
        return option;
      }));
    }
  }
}

/**
 * Follows the country choice: applies the chosen country's rules and tells
 * the page (`onChange`), e.g. to refresh delivery options.
 */
export function enhanceShippingCountry(
  root: ParentNode,
  options: { onChange?: (countryCode: string) => void; signal?: AbortSignal } = {},
): { readCountry(): string } | null {
  const block = root.querySelector<HTMLElement>("[data-foreign-address]");
  const select = root.querySelector<HTMLSelectElement>("select[data-shipping-country]");
  const apply = async (countryCode: string) => {
    if (!block || countryCode === LOCATION_COUNTRY) return;
    const rules = await loadAddressRules(countryCode);
    // The buyer may have moved on while the rules loaded.
    if (rules && readShippingCountry(root) === countryCode) applyAddressRules(block, rules);
  };
  if (!block && !select) return null;
  select?.addEventListener("change", () => {
    const countryCode = readShippingCountry(root);
    void apply(countryCode);
    options.onChange?.(countryCode);
  }, { signal: options.signal });
  void apply(readShippingCountry(root));
  return { readCountry: () => readShippingCountry(root) };
}
