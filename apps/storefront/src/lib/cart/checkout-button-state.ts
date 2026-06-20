export function applyCheckoutButtonState(
  submitButton: HTMLButtonElement,
  options: {
    checkoutUnavailable: boolean;
    unavailableMessage: string;
    isEmpty: boolean;
  },
) {
  const disabled = options.checkoutUnavailable || options.isEmpty;
  submitButton.disabled = disabled;
  submitButton.classList.toggle("opacity-50", disabled);
  submitButton.classList.toggle("cursor-not-allowed", disabled);
  submitButton.title = options.checkoutUnavailable
    ? options.unavailableMessage
    : options.isEmpty
      ? "Your cart is empty"
      : "";
}
