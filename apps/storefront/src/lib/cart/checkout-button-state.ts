export function applyCheckoutButtonState(
  submitButton: HTMLButtonElement,
  options: {
    checkoutUnavailable: boolean;
    unavailableMessage: string;
    isEmpty: boolean;
    cartBlocked?: boolean;
    cartBlockedMessage?: string;
    checkoutPending?: boolean;
    quoteUnverified?: boolean;
    quoteUnverifiedMessage?: string;
  },
) {
  const disabled =
    options.checkoutUnavailable ||
    options.isEmpty ||
    options.cartBlocked === true ||
    options.checkoutPending === true ||
    options.quoteUnverified === true;
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
      : options.quoteUnverified
        ? options.quoteUnverifiedMessage || "Wait for the current order total"
      : "";
}
