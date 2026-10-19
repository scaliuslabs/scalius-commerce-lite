/**
 * Store-level facts a UCP catalog response carries: the return policy
 * (`policies[]`) and the seller of every variant. Both come from the same
 * merchant-saved settings, read through the same rules, as the storefront's
 * MerchantReturnPolicy JSON-LD and store identity, so an agent is told
 * exactly what the product page and its structured data say, and nothing
 * when the merchant has said nothing.
 */
import {
  buildMerchantReturnPolicyJsonLd,
  type MerchantReturnPolicyJsonLd,
  type StorefrontBusinessInfo,
  type StorefrontReturnPolicySettings,
} from "@/lib/commerce-structured-data";
import { resolveStoreName } from "@/lib/store-identity";

export const UCP_RETURN_POLICY_TYPE = "dev.ucp.shopping.policy.return";

export interface UcpPolicy {
  type: string;
  description: { plain: string };
  url?: string;
}

export interface UcpSeller {
  name: string;
  links?: Array<{ type: "refund_policy"; url: string }>;
}

const FREE_RETURN = "https://schema.org/FreeReturn";
const BUYER_PAYS_RETURN = "https://schema.org/ReturnFeesCustomerResponsibility";
const NOT_PERMITTED = "https://schema.org/MerchantReturnNotPermitted";
const UNLIMITED = "https://schema.org/MerchantReturnUnlimitedWindow";
const FINITE = "https://schema.org/MerchantReturnFiniteReturnWindow";

function feeSentence(policy: MerchantReturnPolicyJsonLd): string {
  if (policy.returnFees === FREE_RETURN) return " Return shipping is free.";
  if (policy.returnFees === BUYER_PAYS_RETURN) return " Return shipping is paid by the buyer.";
  return "";
}

/** The plain summary of a valid policy, from its normalized facts only. */
function returnPolicySummary(policy: MerchantReturnPolicyJsonLd): string {
  if (policy.returnPolicyCategory === NOT_PERMITTED) return "Final sale: returns are not accepted.";
  if (policy.returnPolicyCategory === UNLIMITED) return `Returns are accepted with no time limit.${feeSentence(policy)}`;
  if (policy.returnPolicyCategory === FINITE && policy.merchantReturnDays) {
    return `Returns are accepted within ${policy.merchantReturnDays} days of delivery.${feeSentence(policy)}`;
  }
  return "See the store's return policy.";
}

/**
 * The store's return policy as one response-wide UCP policy, or none: only
 * when the merchant enabled it, and only from facts that also pass the
 * MerchantReturnPolicy JSON-LD rules (a saved category with its window, or a
 * policy page on this store).
 */
export function buildUcpPolicies(
  settings: StorefrontReturnPolicySettings | null | undefined,
  storefrontUrl: string,
  fallbackCountry: string | null | undefined,
): UcpPolicy[] {
  const policy = buildMerchantReturnPolicyJsonLd({ settings, storefrontUrl, fallbackCountry });
  if (!policy) return [];
  return [{
    type: UCP_RETURN_POLICY_TYPE,
    description: { plain: returnPolicySummary(policy) },
    ...(policy.merchantReturnLink ? { url: policy.merchantReturnLink } : {}),
  }];
}

/** The seller of every variant: the Business settings name, with the return policy page; none without a name. */
export function buildUcpSeller(
  business: StorefrontBusinessInfo | null | undefined,
  policies: UcpPolicy[],
): UcpSeller | null {
  const name = resolveStoreName(business);
  if (!name) return null;
  const refundUrl = policies.find((policy) => policy.type === UCP_RETURN_POLICY_TYPE)?.url;
  return { name, ...(refundUrl ? { links: [{ type: "refund_policy" as const, url: refundUrl }] } : {}) };
}
