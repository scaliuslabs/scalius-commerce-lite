import { dateLocale } from "@scalius/shared/locale-format";
import { getRuntime } from "@/lib/api/runtime";
import { presencePageLanguage } from "@/lib/market-selector";
import { storeRegion } from "@/lib/store-time-zone";

/** Match Layout's language and country without another API read. */
export async function buyerUiLocaleHeaders(incoming?: Headers): Promise<Record<string, string>> {
  const runtime = getRuntime();
  const layout = await runtime?.layout?.catch(() => null);
  const language = typeof document !== "undefined"
    ? document.documentElement.lang || "en"
    : presencePageLanguage(layout?.markets, runtime?.MARKET_PRESENCE ?? null, "en");
  const supplied = (key: string) => {
    const value = incoming?.get(key);
    return value && /^[A-Za-z0-9-]{1,35}$/.test(value) ? value : undefined;
  };
  return { "x-storefront-language": supplied("x-storefront-language") ?? language, "x-storefront-locale": supplied("x-storefront-locale") ?? dateLocale(language, storeRegion()) };
}
