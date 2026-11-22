// The words for the buyer's view of an order (`@scalius/shared/buyer-order-view`),
// which the server decides and sends with the receipt, the account order, the
// account orders list and the order lookup. Every buyer page words the same
// keys here, in the checkout language, so they never name one order apart.
import type { CheckoutLanguageData } from "@scalius/shared/checkout-language";
import type { BuyerOrderStatusWord, BuyerOrderView } from "@scalius/shared/buyer-order-view";
import type { OrderPaymentWord } from "@scalius/shared/order-payment-words";
import { accountCopy } from "./account-copy";
import { pageLanguage } from "./store-time-zone";
import { buyerApiErrorCopy, type BuyerApiErrorKind } from "./buyer-api-error-copy";
import type { CustomerPaymentRecovery } from "./api/customer-auth";

type PaymentRecoveryRefusal = NonNullable<CustomerPaymentRecovery["refusal"]>;

export type { BuyerOrderDetailView, BuyerOrderView } from "@scalius/shared/buyer-order-view";

/**
 * The order's one status word, the tracker's own words: "Order placed", "On
 * its way", and for a pickup or a service "Ready for pickup", "Picked up",
 * "Preparing", "Completed", as its steps read them (relabelOrderProgress).
 */
export function buyerOrderStatusText(word: BuyerOrderStatusWord, copy: CheckoutLanguageData): string {
  const words = accountCopy().tracking;
  switch (word) {
    case "awaiting_payment": return words.awaitingPayment;
    case "checkout_expired": return words.checkoutExpired;
    case "ready_for_pickup": return copy.orderLineReadyForPickupText;
    case "preparing": return copy.orderLinePreparingText;
    case "picked_up": return copy.orderLinePickedUpText;
    case "completed": return copy.orderReceiptStatusCompletedText;
    default: return words.milestones[word];
  }
}

/**
 * Why no payment would start, in the buyer's words: a closed list of codes
 * (`paymentRecovery.refusal`), never a server message. Null: nothing to say
 * (the order needs no payment).
 */
export function buyerPaymentRefusalText(refusal: PaymentRecoveryRefusal | null | undefined, language?: string | null): string | null {
  const kind = refusal ? REFUSAL_KIND[refusal] : null;
  return kind ? buyerApiErrorCopy(language ?? pageLanguage())[kind] : null;
}

const REFUSAL_KIND: Record<PaymentRecoveryRefusal, BuyerApiErrorKind | null> = {
  not_payable: null,
  checkout_expired: "checkoutExpired",
  payment_attempts_exhausted: "paymentAttemptsExhausted",
  payment_window_ended: "paymentWindowExpired",
  payment_in_progress: "processing",
  order_busy: "orderBusy",
  method_unavailable: "appUnavailable",
};

/** The order's payment word; the dispute words the checkout language lacks come from the page's language. */
export function buyerPaymentText(word: OrderPaymentWord | null, copy: CheckoutLanguageData): string {
  const words = accountCopy().format;
  switch (word) {
    case "unpaid": return copy.orderReceiptPaymentStatusUnpaidText;
    case "partial": return copy.orderReceiptPaymentStatusPartialText;
    case "paid": return copy.orderReceiptPaymentStatusPaidText;
    case "partially_refunded": return copy.orderReceiptStatusPartiallyRefundedText;
    case "refunded": return copy.orderReceiptStatusRefundedText;
    case "failed": return copy.orderReceiptStatusFailedText;
    case "dueOnDelivery": return copy.dueOnDeliveryText;
    case "dueAtPickup": return copy.dueAtPickupText;
    case "dueOnService": return copy.dueAtServiceText;
    case "nothingDue": return copy.orderReceiptPaymentStatusNoPaymentDueText;
    case "disputeOpen": return words.paymentDisputeOpen;
    case "lostToDispute": return words.paymentReturnedByBank;
    case "partlyLostToDispute": return words.paymentPartlyReturnedByBank;
    case "partlyLostRestRefunded": return words.paymentReturnedByBankRestRefunded;
    case null: return copy.orderReceiptStatusNotAvailableText;
  }
}

// Badges tint a surface with a tone and keep the words in the text colour, so
// they read in the theme's light and dark colours alike.
const SUCCESS = "bg-success/15 text-foreground";
const DANGER = "bg-destructive text-destructive-foreground";
const WAITING = "bg-warning/15 text-foreground";
const ACTIVE = "bg-primary/10 text-primary-ink";
const QUIET = "bg-muted text-foreground";

export function buyerOrderBadgeClass(view: Pick<BuyerOrderView, "kind" | "status">): string {
  if (view.kind === "payment_pending") return WAITING;
  switch (view.status) {
    case "delivered": case "picked_up": case "completed": return SUCCESS;
    case "confirmed": case "shipped": case "ready_for_pickup": case "preparing": return ACTIVE;
    case "placed": case "awaiting_payment": return WAITING;
    default: return QUIET;
  }
}

export function buyerPaymentBadgeClass(word: OrderPaymentWord | null): string {
  if (word === "paid") return SUCCESS;
  if (word === "failed") return DANGER;
  // Partly paid stays neutral: the rest is collected at the door or offered beside it.
  if (word === "unpaid" || word === "disputeOpen") return WAITING;
  return QUIET;
}
