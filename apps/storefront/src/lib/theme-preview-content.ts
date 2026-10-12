/** The canonical, bounded data read shared by section redraws and library previews. */
import { homeSectionsShowDeliveryFacts, homeSectionRequests, homeSectionRequestsEmpty, type StorefrontSection } from "@scalius/shared/storefront-theme";
import { DEFAULT_CURRENCY } from "@scalius/shared/currency";
import { getCheckoutConfig, isCheckoutConfigReadFailure, getShippingMethods, getThemePreviewHomepageSections, type LayoutData } from "@/lib/api";
import { presenceMarketCountries } from "@/lib/checkout/shipping-country";
import { buildDeliveryFacts } from "@/lib/delivery-facts";
import { formatMoney } from "@/lib/currency";
import { EMPTY_HOMEPAGE_SECTION_DATA, homepageContent } from "@/lib/homepage-sections";

export async function readThemePreviewContent(token: string, sections: StorefrontSection[], layout: LayoutData, presence: string | null, pageSlug?: string) {
  const data = homeSectionRequestsEmpty(homeSectionRequests(sections)) ? EMPTY_HOMEPAGE_SECTION_DATA
    : await getThemePreviewHomepageSections(token, { ...(pageSlug ? { pageSlug } : {}), sections, presence });
  if (data === null) return null;
  const currencySymbol = layout.currency?.symbol ?? DEFAULT_CURRENCY.symbol;
  const currencyCode = layout.currency?.code ?? DEFAULT_CURRENCY.code;
  const delivery = homeSectionsShowDeliveryFacts(sections);
  const [shippingMethods, checkoutConfig] = delivery ? await Promise.all([getShippingMethods(), getCheckoutConfig()]) : [null, null];
  if (delivery && (shippingMethods === null || checkoutConfig === null || isCheckoutConfigReadFailure(checkoutConfig))) return null;
  const facts = delivery ? buildDeliveryFacts({
    shippingMethods, checkoutConfig, returnPolicy: layout.seo?.returnPolicy,
    formatMoney: (amount) => formatMoney(amount, { code: currencyCode, symbol: currencySymbol }),
    countries: presenceMarketCountries(layout.markets, presence),
  }) : [];
  return { content: homepageContent(data, facts), currencySymbol, currencyCode };
}
