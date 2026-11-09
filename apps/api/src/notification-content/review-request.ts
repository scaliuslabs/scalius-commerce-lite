// Send-time content for `review_request` (Wave B §2.3, §10): the send-time
// recheck (reviews and requests still on, the order still delivered or
// completed, a handed-over line still waiting for its review) and the product
// names plus the order page link: `/account/orders/<id>#reviews` for an
// account's order, `/track-order` for a guest (the OTP handoff), never a
// token. The notifications domain never imports `reviews`; this resolver calls
// the reviews domain's public entry. See `./digital.ts` for the resolver
// contract (`null` = nothing to send, terminal; a throw = retry).
import type { Database } from "@scalius/database/client";
import { buyerStorefrontLink, type NotificationData, type NotificationExtraTemplateData } from "@scalius/core/modules/notifications";
import { reviewRequestSendCheck } from "@scalius/core/modules/reviews";

export interface ReviewRequestContentInput {
  orderId: string;
  /** The outbox row's id-only facts. */
  data: NotificationData;
}

/**
 * Product names for the message, language-neutral (the template may be
 * Bangla): "A", "A, B", "A, B, C…" for more than three.
 */
export function reviewProductsPhrase(names: readonly string[]): string {
  const shown = names.slice(0, 3).join(", ");
  return names.length > 3 ? `${shown}…` : shown;
}

export async function resolveReviewRequestContent(
  db: Database,
  env: Env,
  input: ReviewRequestContentInput,
): Promise<NotificationExtraTemplateData | null> {
  const content = await reviewRequestSendCheck(db, input.orderId);
  if (!content) return null;
  const path = content.accountOwned
    ? `/account/orders/${encodeURIComponent(input.orderId)}#reviews`
    : "/track-order";
  // In the presence the buyer ordered on (`/bn/...`), as the message's language.
  const link = buyerStorefrontLink(env.STOREFRONT_URL, content.presence, path);
  // Without a Store URL the message would carry a relative link: retry until
  // the merchant fills Settings > Store details > Web addresses (then dead-letter).
  if (!link) throw new Error("Store URL is not configured; review request links need it.");
  return {
    review_products: reviewProductsPhrase(content.productNames),
    review_link: link,
  };
}
