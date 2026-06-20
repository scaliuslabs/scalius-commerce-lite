export function applyCheckoutButtonState(
  submitButton: HTMLButtonElement,
  options: {
    checkoutUnavailable: boolean;
    unavailableMessage: string;
    isEmpty: boolean;
    cartBlocked?: boolean;
    cartBlockedMessage?: string;
  },
) {
  const disabled =
    options.checkoutUnavailable || options.isEmpty || options.cartBlocked === true;
  submitButton.disabled = disabled;
  submitButton.classList.toggle("opacity-50", disabled);
  submitButton.classList.toggle("cursor-not-allowed", disabled);
  submitButton.title = options.checkoutUnavailable
    ? options.unavailableMessage
    : options.isEmpty
      ? "Your cart is empty"
      : options.cartBlocked
        ? options.cartBlockedMessage || "Some cart items need attention"
      : "";
}
