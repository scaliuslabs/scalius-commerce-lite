// Whether a buyer's page holds a payment step: a payment action (a card form,
// a hosted or app gateway's pay or retry button) or a payment it waits on the
// buyer for, decided once on the server by the page that draws it, before its
// Layout. A theme's chrome never draws beside one (Layout.astro, `buyerPageChrome`).
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

/** The receipt's own decision: it asks the buyer to pay (a pending or failed online payment), offers a retry, or its order is payable now. */
export function receiptHoldsPaymentStep(input: {
  stateKind: string | undefined;
  retryOptions: number;
  paymentAction: string | null | undefined;
  recoveryEligible: boolean | undefined;
}): boolean {
  return input.stateKind === "payment_pending" || input.stateKind === "payment_issue" || input.retryOptions > 0
    || input.paymentAction === "retry" || input.recoveryEligible === true;
}
