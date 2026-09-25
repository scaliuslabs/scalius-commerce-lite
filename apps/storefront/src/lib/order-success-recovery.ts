// The receipt page without a receipt: a bad, incomplete or foreign link.
import type { CheckoutLanguageData } from "@scalius/shared/checkout-language";

export interface ReceiptRecoveryState {
  title: string;
  message: string;
  status: number;
  action: { href: string; label: string };
}

/**
 * /order-success with no usable order id, or no proof for it in this browser:
 * a friendly page that answers 404 (nothing to show here), never 400, and
 * points to Track your order or, after a hosted payment, to recovery.
 */
export function receiptLinkRecoveryState(
  input: { requestedOrderId: string; recoveryUrl?: string },
  copy: Pick<
    CheckoutLanguageData,
    | "orderReceiptMissingTitleText"
    | "orderReceiptIncompleteTitleText"
    | "orderReceiptBrowserRecoveryMessageText"
    | "orderReceiptTrackOrderHelpText"
    | "orderReceiptVerifyRecoveryText"
    | "trackOrderText"
  >,
): ReceiptRecoveryState {
  return {
    title: input.requestedOrderId ? copy.orderReceiptMissingTitleText : copy.orderReceiptIncompleteTitleText,
    message: input.recoveryUrl ? copy.orderReceiptBrowserRecoveryMessageText : copy.orderReceiptTrackOrderHelpText,
    status: 404,
    action: input.recoveryUrl
      ? { href: input.recoveryUrl, label: copy.orderReceiptVerifyRecoveryText }
      : { href: "/track-order", label: copy.trackOrderText },
  };
}
