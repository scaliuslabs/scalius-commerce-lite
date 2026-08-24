export type CheckoutReceiptState =
  | "order_placed"
  | "order_updated"
  | "payment_pending"
  | "payment_issue"
  | string
  | undefined;

export interface CheckoutReceiptCleanupDecision {
  clearCart: boolean;
  clearCheckoutSession: boolean;
  clearCheckoutAttemptPreservingDraft: boolean;
  clearRecoveryPointer: boolean;
}

export function resolveCheckoutReceiptCleanup(options: {
  receiptState: CheckoutReceiptState;
  recoveryMatchesOrder: boolean;
  recoveryMatchesCheckout: boolean;
  acceptedCheckout: boolean;
}): CheckoutReceiptCleanupDecision {
  const settledReceipt = options.receiptState === "order_placed"
    || options.receiptState === "order_updated";
  const exactCheckout = settledReceipt
    && options.recoveryMatchesOrder
    && options.recoveryMatchesCheckout;
  const clearAcceptedCheckout = exactCheckout && options.acceptedCheckout;

  return {
    clearCart: clearAcceptedCheckout,
    clearCheckoutSession: clearAcceptedCheckout,
    clearCheckoutAttemptPreservingDraft: exactCheckout && !options.acceptedCheckout,
    clearRecoveryPointer: settledReceipt && options.recoveryMatchesOrder,
  };
}
