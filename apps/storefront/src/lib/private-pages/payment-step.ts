// Whether a buyer's page holds a payment step: a payment action (a card form,
// a hosted or app gateway's pay or retry button, a balance the buyer may pay)
// or a payment it waits on the buyer for, decided once on the server by the
// page that draws it, before its Layout. A theme's chrome never draws beside
// one (Layout.astro, `buyerPageChrome`). Every page that shows an order to its
// buyer (the receipt, the account's order) decides with `orderHoldsPaymentStep`,
// from the facts the API sends both alike, so no two pages disagree.
import type { BuyerOrderDetailView } from "@scalius/shared/buyer-order-view";
import { isPaymentPage } from "@/lib/analytics-csp";

interface PaymentStepLocals {
  scaliusBuyerPaymentStep?: boolean;
}

/** Marks the page being rendered as holding a payment step (call it from the page's own frontmatter). */
export function markBuyerPaymentStep(locals: object): void {
  (locals as PaymentStepLocals).scaliusBuyerPaymentStep = true;
}

/** Whether the page holds a payment step: it marked one, or it is a payment page (it takes a card). */
export function holdsBuyerPaymentStep(locals: object): boolean {
  return (locals as PaymentStepLocals).scaliusBuyerPaymentStep === true || isPaymentPage(locals);
}

/** What the API sends of an order with the receipt and the account's order alike. */
export interface OrderPaymentFacts {
  buyerView: Pick<BuyerOrderDetailView, "kind" | "paymentAction"> | null | undefined;
  paymentRecovery?: { eligible: boolean } | null;
}

/**
 * The one decision: an order's page holds a payment step when the order waits
 * on the buyer's online payment (pending or failed), offers a payment now (a
 * retry, or a balance to pay early), is payable by its recovery, or the page
 * offers a method to pay it with (`offeredMethods`). A paid, closed or
 * cash order with nothing to pay holds none.
 */
export function orderHoldsPaymentStep(order: OrderPaymentFacts, offeredMethods = 0): boolean {
  const kind = order.buyerView?.kind;
  return kind === "payment_pending" || kind === "payment_issue" || offeredMethods > 0
    || (order.buyerView?.paymentAction ?? null) !== null || order.paymentRecovery?.eligible === true;
}
