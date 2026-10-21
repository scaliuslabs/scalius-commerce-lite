import { dateLocale } from "@scalius/shared/locale-format";
import { storeRegion } from "@/lib/store-time-zone";

/** The page's language and locale for buyer UI, in the browser (no API read). */
export function browserBuyerUiLocaleHeaders(): Record<string, string> {
  const language = document.documentElement.lang || "en";
  return { "x-storefront-language": language, "x-storefront-locale": dateLocale(language, storeRegion()) };
}
