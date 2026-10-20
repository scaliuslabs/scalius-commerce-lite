/**
 * Place order stays enabled while the buyer is still filling the form (Baymard:
 * never a silent disabled button); submitting marks every missing field, and
 * the submit handler refuses a COD order until its total is verified.
 *
 * A disabled Place order says why in a visible line under it, in the checkout
 * language, which the button names with `aria-describedby` (a `title` tooltip
 * never shows on touch screens and is not reliably read out).
 */
export function applyCheckoutButtonState(
  submitButton: HTMLButtonElement,
  options: {
    checkoutUnavailable: boolean;
    unavailableMessage: string;
    isEmpty: boolean;
    /** "Add items to your cart before placing an order." */
    emptyMessage: string;
    cartBlocked?: boolean;
    cartBlockedMessage?: string;
    /** "Some cart items need attention" when the cart names no reason. */
    cartAttentionMessage?: string;
    /** A store app's rule blocks the order (its messages are on the page). */
    cartRulesBlocked?: boolean;
    cartRulesBlockedMessage?: string;
    checkoutPending?: boolean;
    checkoutPendingMessage?: string;
    discountValidationPending?: boolean;
    discountValidationPendingMessage?: string;
    /** The visible reason line under the button. */
    reasonElement?: HTMLElement | null;
  },
) {
  const disabled =
    options.checkoutUnavailable ||
    options.isEmpty ||
    options.cartBlocked === true ||
    options.cartRulesBlocked === true ||
    options.checkoutPending === true ||
    options.discountValidationPending === true;
  submitButton.disabled = disabled;
  submitButton.classList.toggle("opacity-50", disabled);
  submitButton.classList.toggle("cursor-not-allowed", disabled);
  submitButton.removeAttribute("title");
  const reason = !disabled
    ? ""
    : options.checkoutUnavailable
      ? options.unavailableMessage
      : options.isEmpty
        ? options.emptyMessage
        : options.cartBlocked
          ? options.cartBlockedMessage || options.cartAttentionMessage || ""
          : options.cartRulesBlocked
            ? options.cartRulesBlockedMessage || ""
            : options.checkoutPending
              ? options.checkoutPendingMessage || ""
              : options.discountValidationPendingMessage || "";
  const line = options.reasonElement;
  if (!line) return;
  if (line.textContent !== reason) line.textContent = reason;
  line.hidden = reason === "";
  const describedBy = new Set((submitButton.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean));
  if (reason && line.id) describedBy.add(line.id);
  else describedBy.delete(line.id);
  if (describedBy.size > 0) submitButton.setAttribute("aria-describedby", [...describedBy].join(" "));
  else submitButton.removeAttribute("aria-describedby");
}
