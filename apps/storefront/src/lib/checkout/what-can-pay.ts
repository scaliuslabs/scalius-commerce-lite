// What can pay for a cart cash can't pay for (a key, a download, a gift card),
// said the same way on the cart, on the payment step and on the cart page's
// no-script refusal: a pay-later method (the invoice, an app's) for a
// signed-in buyer it reaches, named as the store names it; a gift card while
// the store holds a live one (checkout configuration's `giftCardsLive`);
// otherwise nothing, and the words say so. Browser-safe.
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

/**
 * The words for a cart whose lines `items` (already listed) cash can't pay
 * for and no method this buyer has can take: a guest may sign in to pay
 * later; a signed-in buyer is told the pay-later method isn't open to their
 * account; with no pay-later method a gift card can pay while the store holds
 * a live one, and otherwise the store takes nothing that can.
 */
export function whatCanPayText(
  copy: Pick<CheckoutLanguageData, "cartOnlinePaymentRequiredText" | "cartPayLaterSignInText" | "cartPayLaterNotOpenText" | "paymentGiftCardOnlyText">,
  input: { items: string; gateways: readonly PayableGateway[]; signedIn: boolean; giftCardsLive: boolean },
): string {
  const later = payLaterMethod(input.gateways);
  if (!later) {
    return checkoutText(input.giftCardsLive ? copy.paymentGiftCardOnlyText : copy.cartOnlinePaymentRequiredText, { items: input.items });
  }
  const method = later.name?.trim() || later.id || "";
  return checkoutText(input.signedIn ? copy.cartPayLaterNotOpenText : copy.cartPayLaterSignInText, { items: input.items, method });
}

/** Whether the page's buyer is signed in (the layout's cookie flag; the server still decides). */
export function pageBuyerSignedIn(): boolean {
  return typeof document !== "undefined" && document.documentElement.hasAttribute("data-scalius-signed-in");
}
