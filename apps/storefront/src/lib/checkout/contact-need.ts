/**
 * Whether this checkout needs the buyer's phone: the shared contact rule
 * (`orderContactNeeds` in @scalius/shared/customer-auth-policy), applied to
 * the cart in the browser. The API applies the same rule to the order it
 * commits, so the page only decides what to ask for.
 *
 * The information step does not know the payment method yet. It assumes the
 * one that needs the most: a deferred method when one is offered (the
 * invoice, or an app's pay-later method, `flow: "deferred"`), else cash when
 * the cart can be paid in cash (a service line and an enabled cash method),
 * else the store's deposit plan, else a full online payment. A phone that
 * the rule lets go is optional; email is then required.
 */
import {
  orderContactNeeds,
  type CustomerIdentitySettings,
  type OrderContactNeeds,
  type OrderPaymentKind,
} from "@scalius/shared/customer-auth-policy";
import { isFulfillmentKind } from "@scalius/shared/fulfilment";

export interface CheckoutContactNeedInput {
  identity: Pick<CustomerIdentitySettings, "email" | "phoneOptionalForDigital">;
  /** The cart lines; a line without a known kind counts as physical. */
  lines: ReadonlyArray<{ fulfillmentKind?: unknown }>;
  /** Cash on delivery (or at the service) is an enabled method. */
  cashEnabled: boolean;
  /** A deferred method is offered: the invoice (`net_terms`) or an app's `flow: "deferred"` gateway. */
  deferredEnabled?: boolean;
  /** The store takes an advance deposit online. */
  partialPaymentEnabled: boolean;
  /** The order's country (the page market's, when nothing ships); null is Bangladesh. */
  countryCode: string | null;
}

export function checkoutContactNeeds(input: CheckoutContactNeedInput): OrderContactNeeds {
  const lines = input.lines.map((line) => ({
    fulfillmentKind: isFulfillmentKind(line.fulfillmentKind) ? line.fulfillmentKind : "physical" as const,
    isGiftCard: false,
  }));
  // Digital lines alone can't be paid in cash; a service line can.
  const cashPossible = input.cashEnabled && lines.some((line) => line.fulfillmentKind !== "digital");
  const payment: OrderPaymentKind = input.deferredEnabled === true
    ? "deferred"
    : cashPossible ? "cod" : input.partialPaymentEnabled ? "partial" : "online";
  return orderContactNeeds(input.identity, { lines, payment, countryCode: input.countryCode });
}

/** Whether the checkout offers a deferred (pay later) method, by the gateways it lists. */
export function offersDeferredPayment(gateways: ReadonlyArray<{ id?: string; flow?: string }>): boolean {
  return gateways.some((gateway) => gateway.flow === "deferred" || gateway.id === "net_terms");
}

/**
 * Shows the decision on the checkout form: the page root's `data-phone-need`
 * picks the labels that are true (the markup carries both), and the email
 * field is required whenever the phone is optional.
 */
export function applyCheckoutContactNeeds(
  needs: Pick<OrderContactNeeds, "phone" | "email">,
  root: ParentNode = document,
): void {
  const page = root.querySelector<HTMLElement>("#cartPageRoot, [data-contact-root]");
  if (page && page.dataset.phoneNeed !== needs.phone) page.dataset.phoneNeed = needs.phone;
  const phone = root.querySelector<HTMLInputElement>("#customerPhone-input");
  phone?.setAttribute("aria-required", needs.phone === "required" ? "true" : "false");
  const email = root.querySelector<HTMLInputElement>("#customerEmail");
  if (email) {
    email.required = needs.email === "required";
    email.setAttribute("aria-required", needs.email === "required" ? "true" : "false");
  }
}

/** The page's decision, as `applyCheckoutContactNeeds` left it (required until decided). */
export function readCheckoutPhoneNeed(root: ParentNode = document): "required" | "optional" {
  const page = root.querySelector<HTMLElement>("#cartPageRoot, [data-contact-root]");
  return page?.dataset.phoneNeed === "optional" ? "optional" : "required";
}
