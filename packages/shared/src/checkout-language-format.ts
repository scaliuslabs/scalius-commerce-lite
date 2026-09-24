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
 * One applied discount as receipts, order emails and the cart name it:
 * "Discount · Eid sale (EID10)", "Discount · EID10" when the title is the code,
 * "Discount · Eid sale" for an automatic discount.
 */
export function formatDiscountLineLabel(
  discountText: string,
  line: { title: string; code: string | null },
): string {
  const title = line.title.trim();
  const code = line.code?.trim() || null;
  const name = code && code !== title ? `${title} (${code})` : title || code || "";
  return name ? `${discountText} · ${name}` : discountText;
}
