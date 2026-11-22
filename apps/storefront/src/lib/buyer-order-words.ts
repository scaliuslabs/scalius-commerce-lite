// The words for the buyer's view of an order (`@scalius/shared/buyer-order-view`),
// which the server decides and sends with the receipt, the account order, the
// account orders list and the order lookup. Every buyer page words the same
// keys here, in the checkout language, so they never name one order apart.
import type { CheckoutLanguageData } from "@scalius/shared/checkout-language";
import type { BuyerOrderStatusWord, BuyerOrderView } from "@scalius/shared/buyer-order-view";
import type { OrderPaymentWord } from "@scalius/shared/order-payment-words";
import { accountCopy } from "./account-copy";

export type { BuyerOrderDetailView, BuyerOrderView } from "@scalius/shared/buyer-order-view";

/** The order's one status word ("Confirmed" for a processing order too). */
export function buyerOrderStatusText(word: BuyerOrderStatusWord, copy: CheckoutLanguageData): string {
  switch (word) {
    case "awaiting_payment": return copy.orderReceiptStatusIncompleteText;
    case "placed": return copy.orderReceiptStatusPendingText;
    case "confirmed": return copy.orderReceiptStatusConfirmedText;
    case "shipped": return copy.orderReceiptStatusShippedText;
    case "delivered": return copy.orderReceiptStatusDeliveredText;
    case "cancelled": return copy.orderReceiptStatusCancelledText;
    case "returned": return copy.orderReceiptStatusReturnedText;
    case "refunded": return copy.orderReceiptStatusRefundedText;
  }
}

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
  if (view.status === "delivered") return SUCCESS;
  if (view.status === "confirmed" || view.status === "shipped") return ACTIVE;
  if (view.status === "placed") return WAITING;
  return QUIET;
}

export function buyerPaymentBadgeClass(word: OrderPaymentWord | null): string {
  if (word === "paid") return SUCCESS;
  if (word === "failed") return DANGER;
  // Partly paid stays neutral: the rest is collected at the door or offered beside it.
  if (word === "unpaid" || word === "disputeOpen") return WAITING;
  return QUIET;
}
