/**
 * Place order stays enabled while the buyer is still filling the form (Baymard:
 * never a silent disabled button); submitting marks every missing field, and
 * the submit handler refuses a COD order until its total is verified.
 */
export function applyCheckoutButtonState(
  submitButton: HTMLButtonElement,
  options: {
    checkoutUnavailable: boolean;
    unavailableMessage: string;
    isEmpty: boolean;
    cartBlocked?: boolean;
    cartBlockedMessage?: string;
    checkoutPending?: boolean;
    discountValidationPending?: boolean;
    discountValidationPendingMessage?: string;
  },
) {
  const disabled =
    options.checkoutUnavailable ||
    options.isEmpty ||
    options.cartBlocked === true ||
    options.checkoutPending === true ||
    options.discountValidationPending === true;
  submitButton.disabled = disabled;
  submitButton.classList.toggle("opacity-50", disabled);
  submitButton.classList.toggle("cursor-not-allowed", disabled);
  submitButton.title = options.checkoutUnavailable
    ? options.unavailableMessage
    : options.isEmpty
      ? "Your cart is empty"
      : options.cartBlocked
        ? options.cartBlockedMessage || "Some cart items need attention"
      : options.checkoutPending
        ? "Continue or review the existing checkout before placing another order"
      : options.discountValidationPending
        ? options.discountValidationPendingMessage || "Processing…"
      : "";
}
