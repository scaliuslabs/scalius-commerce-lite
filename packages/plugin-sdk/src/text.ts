import { formatMoney as formatStoreMoney, getDecimalPlaces } from "@scalius/shared/currency";

/**
 * Your words in a reader's language: `texts[language]`, else its base
 * language (`pt-BR` → `pt`), else English. In a checkout function or a
 * storefront extension pass `input.language` (the buyer's); on an admin
 * screen `adminContext(request).locale` (the staff member's).
 *
 *   title: textFor(input.language, { en: "Gift wrap", bn: "গিফট র‍্যাপ" })
 */
export function textFor<T>(language: string | null | undefined, texts: { readonly en: T } & Readonly<Record<string, T>>): T {
  if (language) {
    const wanted = language.toLowerCase();
    for (const tag of [wanted, wanted.split("-")[0]!]) {
      const match = Object.keys(texts).find((key) => key.toLowerCase() === tag);
      if (match !== undefined) return texts[match]!;
    }
  }
  return texts.en;
}

/**
 * An amount (integer minor units of its ISO currency) in a reader's language,
 * as the store writes money on its pages: whole amounts without decimals.
 * In a storefront extension pass `input.language` and money in `input.currency`.
 *
 *   moneyFor("en", { amountMinor: 35_000, currency: "BDT" })  // "৳350"
 *   moneyFor("bn", { amountMinor: 35_000, currency: "BDT" })  // "৳৩৫০"
 *   moneyFor("en", { amountMinor: 35_050, currency: "BDT" })  // "৳350.50"
 *   moneyFor("en", { amountMinor: 287, currency: "USD" })     // "$2.87"
 */
export function moneyFor(language: string | null | undefined, money: { amountMinor: number; currency: string }): string {
  return formatStoreMoney(money.amountMinor / 10 ** getDecimalPlaces(money.currency), { code: money.currency, language: language || "en" });
}
