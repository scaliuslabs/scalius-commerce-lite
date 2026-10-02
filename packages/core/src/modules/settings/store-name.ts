// The store's display name, from the business and Platform settings alone
// (pure): messages, sender names and apps' `ctx.store.name` all read it here.
import { normalizeStorefrontOrigin } from "@scalius/shared/storefront-url";
import type { BusinessInfo } from "./documents";

/**
 * The store's name in every buyer and staff message (headers, sender name,
 * `{{store_name}}`): the business name, else the legal name, else the Store
 * URL's host (e.g. `shop.example.com`). Null only while none of them is set.
 */
export function storeDisplayName(
  business: Pick<BusinessInfo, "companyName" | "legalName">,
  storefrontUrl: string,
): string | null {
  const businessName = business.companyName.trim() || business.legalName.trim();
  if (businessName) return businessName;
  const origin = normalizeStorefrontOrigin(storefrontUrl);
  return origin ? new URL(origin).host.replace(/^www\./, "") : null;
}
