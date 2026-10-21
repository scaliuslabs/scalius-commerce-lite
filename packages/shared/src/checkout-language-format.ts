/**
 * A checkout language code's base language ("bn-BD" and "BN_bd" are "bn"),
 * "en" when there is none. Here, not in checkout-language.ts, so browser
 * copy pickers do not load the preset catalog.
 */
export function checkoutLanguageBaseCode(code: unknown): string {
  if (typeof code !== "string") return "en";
  return code.trim().toLowerCase().split(/[-_]/, 1)[0] || "en";
}

/** Fills `{placeholder}` tokens in merchant checkout copy. */
export function formatCheckoutLanguageText(
  template: string,
  values: Readonly<Record<string, string | number>>,
): string {
  return template.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match,
  );
}

/**
 * One applied discount as the buyer sees it in the cart, at checkout, on the
 * receipt, the account order page and order emails: "Discount · EID10".
 */
export function formatDiscountLineLabel(
  discountText: string,
  line: BuyerDiscountLine,
): string {
  const name = buyerDiscountName(line);
  return name ? `${discountText} · ${name}` : discountText;
}

/** An applied discount line: a store app's (`appId` set) or the store's own. */
export interface BuyerDiscountLine {
  title: string | null;
  code: string | null;
  appId?: string | null;
}

/**
 * An applied discount's name for buyers (Shopify's rule): the store's code
 * discount by its code ("EID10"), an automatic discount by its title ("Eid
 * sale"). The name staff gave a code discount stays in the dashboard. A store
 * app names its own discounts for buyers, so its title stays (with its code).
 */
export function buyerDiscountName(line: BuyerDiscountLine): string {
  const code = line.code?.trim() ?? "";
  if (code && !line.appId) return code;
  return discountDisplayName(line);
}

/**
 * An applied discount's name for staff (the dashboard): "Eid sale (EID10)",
 * just "EID10" when the title is the code (in any letter case), "Eid sale"
 * for an automatic discount.
 */
export function discountDisplayName(line: { title: string | null; code: string | null }): string {
  const title = line.title?.trim() ?? "";
  const code = line.code?.trim() ?? "";
  if (!code || code.toLocaleLowerCase() === title.toLocaleLowerCase()) return title || code;
  return title ? `${title} (${code})` : code;
}
