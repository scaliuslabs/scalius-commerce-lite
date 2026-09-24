import { cartStore, removeOrderedLines, syncCartFromStorage } from "@/store/cart";
import {
  clearCheckoutAttemptSession,
  clearCheckoutSession,
  clearHostedPaymentRecoverySession,
  fingerprintCheckoutCart,
  hashCheckoutCartFingerprint,
  readHostedPaymentRecoverySession,
} from "./session-state";

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
  directCheckoutMatches?: boolean;
  acceptedCheckout: boolean;
}): CheckoutReceiptCleanupDecision {
  const settledReceipt = options.receiptState === "order_placed"
    || options.receiptState === "order_updated";
  const exactCheckout = settledReceipt
    && (
      (options.recoveryMatchesOrder && options.recoveryMatchesCheckout)
      || options.directCheckoutMatches === true
    );
  const clearAcceptedCheckout = exactCheckout && options.acceptedCheckout;

  return {
    clearCart: clearAcceptedCheckout,
    clearCheckoutSession: clearAcceptedCheckout,
    clearCheckoutAttemptPreservingDraft: exactCheckout && !options.acceptedCheckout,
    clearRecoveryPointer: settledReceipt && options.recoveryMatchesOrder,
  };
}

const SUBMITTED_CART_KEY = "scalius_submitted_cart";
const LAST_ORDER_KEY = "scalius_last_order";

/** The exact cart lines this tab submitted for an order, kept until its receipt. */
export function rememberSubmittedCart(cartItems: string): void {
  try {
    sessionStorage.setItem(SUBMITTED_CART_KEY, cartItems);
  } catch {
    // Without it the receipt falls back to matching the whole cart.
  }
}

function readSessionValue(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

/** The order this tab last placed, so a stale /checkout can point to it. */
export function readLastPlacedOrderId(): string | null {
  const value = readSessionValue(LAST_ORDER_KEY);
  return value && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : null;
}

/**
 * After a placed order, takes exactly its lines out of the cart (lines added
 * meanwhile, for example in another tab, stay) and ends the checkout session.
 * Only the tab that submitted this checkout may finalize it.
 */
export async function finalizeCheckoutReceipt(receiptElement: HTMLElement): Promise<void> {
  const receiptState = receiptElement.dataset.orderSuccessState;
  const orderId = receiptElement.dataset.orderId;
  if (!orderId || (receiptState !== "order_placed" && receiptState !== "order_updated")) return;

  syncCartFromStorage();
  const submitted = readSessionValue(SUBMITTED_CART_KEY);
  const ordered = submitted ?? JSON.stringify(cartStore.get().items);
  const activeCheckoutId = readSessionValue("checkoutId");
  const recovery = readHostedPaymentRecoverySession();
  const recoveryMatchesOrder = recovery?.orderId === orderId;
  const recoveryMatchesCheckout = Boolean(
    recoveryMatchesOrder
    && recovery.cartFingerprint
    && recovery.cartFingerprint === fingerprintCheckoutCart(ordered)
    && (!recovery.checkoutId || recovery.checkoutId === activeCheckoutId),
  );
  const directCheckoutId = receiptElement.dataset.checkoutFinalizeId;
  const directCartHash = receiptElement.dataset.checkoutFinalizeCartHash;
  const directCheckoutMatches = Boolean(
    directCheckoutId
    && directCartHash
    && activeCheckoutId === directCheckoutId
    && await hashCheckoutCartFingerprint(ordered) === directCartHash,
  );
  const cleanup = resolveCheckoutReceiptCleanup({
    receiptState,
    recoveryMatchesOrder,
    recoveryMatchesCheckout,
    directCheckoutMatches,
    acceptedCheckout: receiptElement.dataset.checkoutCartFinalize === "true",
  });
  if (cleanup.clearCart) {
    try {
      removeOrderedLines(JSON.parse(ordered) as Record<string, { variantId?: unknown; quantity?: unknown }>);
    } catch {
      // A malformed snapshot leaves the cart as it is.
    }
  }
  if (cleanup.clearCheckoutSession) {
    clearCheckoutSession();
    try {
      sessionStorage.removeItem(SUBMITTED_CART_KEY);
      sessionStorage.setItem(LAST_ORDER_KEY, orderId);
    } catch {
      // Storage is a convenience here.
    }
  }
  if (cleanup.clearCheckoutAttemptPreservingDraft) {
    clearCheckoutAttemptSession({ preserveFormDraft: true });
  }
  if (cleanup.clearRecoveryPointer) clearHostedPaymentRecoverySession();
}
