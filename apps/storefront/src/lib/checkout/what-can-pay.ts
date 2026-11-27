// What can pay for a cart cash can't pay for (a key, a download, a gift card),
// said the same way on the cart, on the payment step and on the cart page's
// no-script refusal, and only what is certain: a pay-later method (the
// invoice, an app's) for a signed-in buyer it reaches, named as the store
// names it; on a store that takes only cash, a gift card while the store holds
// a live one (checkout configuration's `giftCardsLive`, read only there), else
// that it takes nothing else yet. A store with another way to pay that refuses
// this order (its amount limits) gets the page's neutral words. Browser-safe.
import { checkoutText } from "@/lib/checkout-text";
import type { CheckoutLanguageData } from "@scalius/shared/checkout-language";

export interface PayableGateway {
  id?: string;
  name?: string;
  flow?: string;
  paymentKind?: string;
}

/** The names of the lines cash can't pay for (digital items and gift cards: core's `cashPayable`), once each. */
export function cashUnpayableNames(items: ReadonlyArray<{ productName: string; fulfillmentType?: string | null }>): string[] {
  return [...new Set(items
    .filter((item) => item.fulfillmentType === "digital" || item.fulfillmentType === "gift_card")
    .map((item) => item.productName.trim())
    .filter(Boolean))];
}

/** The store's pay-later method that can pay for a key (a deferred method that is not cash), by its name. */
export function payLaterMethod(gateways: readonly PayableGateway[]): PayableGateway | null {
  return gateways.find((gateway) => (gateway.flow === "deferred" || gateway.id === "net_terms")
    && gateway.paymentKind !== "cash_on_delivery") ?? null;
}

/** A listed way to pay that is neither cash nor a pay-later method (a card, a hosted gateway): it pays for anything it accepts. */
function listsGatewayBesidesCash(gateways: readonly PayableGateway[]): boolean {
  return gateways.some((gateway) => gateway.paymentKind !== "cash_on_delivery" && gateway.flow !== "cod"
    && gateway.flow !== "deferred" && gateway.id !== "net_terms");
}

/**
 * The words for a cart whose lines `items` (already listed) cash can't pay
 * for and no method this buyer has can take: a guest may sign in with an
 * approved account to pay later; a signed-in buyer is told the pay-later
 * method isn't open to their account; on a store that takes only cash, a gift
 * card can pay while one is live, and otherwise the store takes nothing else
 * yet. Null where none of that is the reason (a gateway is listed and refuses
 * this order): the caller's neutral words.
 */
export function whatCanPayText(
  copy: Pick<CheckoutLanguageData, "cartOnlinePaymentRequiredText" | "cartPayLaterSignInText" | "cartPayLaterNotOpenText" | "paymentGiftCardOnlyText">,
  input: { items: string; gateways: readonly PayableGateway[]; signedIn: boolean; giftCardsLive: boolean },
): string | null {
  const later = payLaterMethod(input.gateways);
  if (later) {
    const method = later.name?.trim() || later.id || "";
    return checkoutText(input.signedIn ? copy.cartPayLaterNotOpenText : copy.cartPayLaterSignInText, { items: input.items, method });
  }
  if (listsGatewayBesidesCash(input.gateways)) return null;
  return checkoutText(input.giftCardsLive ? copy.paymentGiftCardOnlyText : copy.cartOnlinePaymentRequiredText, { items: input.items });
}

/** Whether the page's buyer is signed in (the layout's cookie flag; the server still decides). */
export function pageBuyerSignedIn(): boolean {
  return typeof document !== "undefined" && document.documentElement.hasAttribute("data-scalius-signed-in");
}
