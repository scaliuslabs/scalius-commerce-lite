// What an app charged on a buyer's order row, in words: the one formatter the
// receipt, the account order, the order email and the invoice draw a row's
// `addOns` through (a buyer row's entries never carry an add-on: `addOns` is
// its one place). "Protection · ৳350 each", "· ৳350 per set" (a kit's or a
// bundle's add-on, once per set), or "· ৳1,050 in all" when no one amount is
// exact for every unit; a free add-on is its title alone. A leaf: no imports,
// so a buyer page's script pays for nothing else.

/** A row add-on as every surface holds it (`BuyerLineAddOn`, minor units of the order's currency). */
export interface BuyerLineAddOnFacts {
  title: string;
  totalMinor: number;
  amountMinor: number | null;
  per: "unit" | "bundle";
}

/** The platform's words for an add-on's amount, by language (`{amount}` is the formatted money). */
export const ADD_ON_AMOUNT_WORDS = {
  en: { unit: "{amount} each", bundle: "{amount} per set", total: "{amount} in all" },
  bn: { unit: "প্রতিটি {amount}", bundle: "প্রতি সেটে {amount}", total: "মোট {amount}" },
} as const;

/** The amount words of a language: Bangla for `bn` (`bn-BD`), else English. */
export function addOnAmountWords(language: string | null | undefined): (typeof ADD_ON_AMOUNT_WORDS)[keyof typeof ADD_ON_AMOUNT_WORDS] {
  return (language ?? "").toLowerCase().split(/[-_]/, 1)[0] === "bn" ? ADD_ON_AMOUNT_WORDS.bn : ADD_ON_AMOUNT_WORDS.en;
}

/** A row's add-ons as read from an API answer: well-formed entries only (a page may hold an untyped answer). */
export function readBuyerLineAddOns(value: unknown): BuyerLineAddOnFacts[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): BuyerLineAddOnFacts[] => {
    const { title, totalMinor, amountMinor, per } = (entry ?? {}) as Record<string, unknown>;
    if (typeof title !== "string" || !title.trim() || !Number.isSafeInteger(totalMinor) || (totalMinor as number) < 0) return [];
    if (amountMinor !== null && (!Number.isSafeInteger(amountMinor) || (amountMinor as number) < 0)) return [];
    return [{ title: title.trim(), totalMinor: totalMinor as number, amountMinor: amountMinor as number | null, per: per === "bundle" ? "bundle" : "unit" }];
  });
}

/** One add-on's words: its title, then its amount per unit, per set, or in all. */
export function buyerLineAddOnText(addOn: BuyerLineAddOnFacts, money: (minor: number) => string, language: string | null | undefined): string {
  if (addOn.totalMinor === 0) return addOn.title;
  const words = addOnAmountWords(language);
  const amount = addOn.amountMinor === null
    ? words.total.replace("{amount}", money(addOn.totalMinor))
    : (addOn.per === "bundle" ? words.bundle : words.unit).replace("{amount}", money(addOn.amountMinor));
  return `${addOn.title} · ${amount}`;
}

/**
 * A row's add-ons as the rows a surface draws under the line beside its
 * buyer inputs: `label` is the surface's own word for an add-on ("Add-on",
 * the checkout language's `lineAddOnText`), `value` the add-on in words.
 */
export function buyerLineAddOnRows(
  addOns: unknown,
  options: { label: string; money: (minor: number) => string; language: string | null | undefined },
): Array<{ label: string; value: string; surcharge: null; text: string }> {
  return readBuyerLineAddOns(addOns).map((addOn) => {
    const value = buyerLineAddOnText(addOn, options.money, options.language);
    return { label: options.label, value, surcharge: null, text: `${options.label}: ${value}` };
  });
}

/** What the apps charged on a row, exactly (its `addOns`' totals). */
export function rowAddOnsMinor(row: { addOns?: unknown }): number {
  return readBuyerLineAddOns(row.addOns).reduce((sum, addOn) => sum + addOn.totalMinor, 0);
}

/**
 * A row's own amounts when the summary shows the apps' add-ons as their own
 * rows: its gross less what the apps charged on it, and the unit price of
 * that when it is exact. Then the rows add up to the summary's Subtotal (the
 * items alone) and the add-on rows to the rest, the same on every page and
 * document (the receipt, the account order, the order emails, the invoice).
 */
export function rowItemsOnly<T extends { unitPriceMinor: number | null; grossSubtotalMinor: number }>(
  line: T | null,
  row: { quantity: number; addOns?: unknown },
  addOnsInSummary: boolean,
): T | null {
  if (!line || !addOnsInSummary) return line;
  const addOnsMinor = rowAddOnsMinor(row);
  if (addOnsMinor === 0 || addOnsMinor > line.grossSubtotalMinor) return line;
  const grossSubtotalMinor = line.grossSubtotalMinor - addOnsMinor;
  const unitPriceMinor = row.quantity > 0 && grossSubtotalMinor % row.quantity === 0 ? grossSubtotalMinor / row.quantity : null;
  const total = (line as { totalMinor?: unknown }).totalMinor;
  return { ...line, grossSubtotalMinor, unitPriceMinor, ...(typeof total === "number" ? { totalMinor: total - addOnsMinor } : {}) };
}
