// Per-line Wave B extras (a review, downloads and keys, the store's delivery
// message, issued gift cards, a warranty) under each order line: server-rendered on the receipt by
// `components/order/LineExtras.astro`, and as markup on the browser-rendered
// account order page through `lineExtrasMarkup`. Each feature owns its part
// and renders nothing when it has nothing to show, so a line without extras
// adds no markup.
import type { FulfillmentType } from "@scalius/shared/fulfilment";
import type { CheckoutLanguageData } from "@scalius/shared/checkout-language";
import type { ConversationAccess } from "@/lib/account-inbox";
import { digitalLineDeliveryMarkup, type DigitalDownloadsExtra, type LicenceKeysExtra } from "@/components/order/digital-line-delivery";
import { giftCardLineDeliveryMarkup, type GiftCardsExtra } from "@/components/order/gift-card-line-delivery";
import { reviewLineActionMarkup, type ReviewLineExtra } from "@/components/order/review-line-action";
import { warrantyLineInfoMarkup, type WarrantyLineExtra } from "@/components/order/warranty-line-info";
import { deliveryMessageLineMarkup, type DeliveryMessageExtra } from "@/components/order/delivery-message-line";

/** `items[].extras` on the receipt and the account order (composed by the API; absent until each feature ships). */
export interface OrderLineExtras {
  review?: ReviewLineExtra;
  downloads?: DigitalDownloadsExtra;
  licenceKeys?: LicenceKeysExtra;
  giftCards?: GiftCardsExtra;
  warranty?: WarrantyLineExtra;
  /** The account order only: the store's delivery message for this row, by id (never on a receipt). */
  message?: DeliveryMessageExtra;
}

/** What the receipt and the account order both know about a line. */
export interface OrderLine {
  id: string;
  productId: string;
  variantId: string | null;
  quantity: number;
  productName: string | null;
  fulfillmentType?: FulfillmentType;
  fulfilledQuantity?: number;
  extras?: OrderLineExtras | null;
}

/** Whose page it is: a receipt (guest proof cookie) or the signed-in account. */
export interface LineExtrasContext {
  orderId: string;
  access: ConversationAccess;
  /** The page's checkout language (the store's language, the merchant's wording); English where it has no word. */
  languageData?: Partial<CheckoutLanguageData> | null;
}

/** The account order page's per-line extras, in the receipt's order. */
export function lineExtrasMarkup(line: OrderLine, context: LineExtrasContext): string {
  if (!line.extras) return "";
  return [
    reviewLineActionMarkup(line, context),
    digitalLineDeliveryMarkup(line, context),
    deliveryMessageLineMarkup(line, context),
    giftCardLineDeliveryMarkup(line, context),
    warrantyLineInfoMarkup(line, context),
  ].join("");
}
