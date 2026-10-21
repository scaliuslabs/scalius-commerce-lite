// The bar a merchant sees on the normal storefront while their browser holds
// a live theme preview (the draft renders instead of the published theme):
// it says so and offers to leave, like Shopify's preview bar. Buyers never
// see it: it needs a valid preview, and preview pages are never cached.
import { checkoutLanguageBaseCode } from "@scalius/shared/checkout-language-format";

export interface ThemePreviewBarCopy {
  label: string;
  exit: string;
}

const COPY: Record<"en" | "bn", ThemePreviewBarCopy> = {
  en: { label: "Previewing unpublished theme", exit: "Exit preview" },
  bn: { label: "অপ্রকাশিত থিমের প্রিভিউ দেখছেন", exit: "প্রিভিউ বন্ধ করুন" },
};

/** The bar's words in the store's language (Bangla for `bn…`, else English). */
export function themePreviewBarCopy(languageCode: unknown): ThemePreviewBarCopy {
  return COPY[checkoutLanguageBaseCode(languageCode) === "bn" ? "bn" : "en"];
}

/**
 * Whether this page shows the bar: only under a live preview, and only in a
 * tab of its own. The theme editor and the preview shell frame the storefront
 * and have their own controls, so a framed page (`Sec-Fetch-Dest: iframe`)
 * does not repeat them.
 */
export function showsThemePreviewBar(isThemePreview: boolean, request: Request): boolean {
  return isThemePreview && request.headers.get("sec-fetch-dest") !== "iframe";
}
