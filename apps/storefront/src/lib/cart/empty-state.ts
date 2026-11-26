import type { CheckoutLanguageData } from "../api/types";

export interface EmptyCartRecoveryAction {
  href: string;
}

const PRIMARY = "inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-primary-foreground bg-primary hover:bg-primary-hover";
const SECONDARY = "inline-flex items-center px-4 py-2 border border-border shadow-sm text-sm font-medium rounded-md text-foreground bg-background hover:bg-muted";

/**
 * Sets the page's empty state (`[data-cart-empty]` in cart.astro, drawn by
 * the server and shown by the cart state) for a payment that may already
 * have been made: its message and a link to the payment's status before the
 * link back to the shop. Without one it is the page's plain state again. It
 * only enhances: the message and the link back to the shop are the page's
 * markup, so a file that cannot load leaves them shown.
 */
export function renderEmptyCartState(
  lang: CheckoutLanguageData,
  recoveryAction?: EmptyCartRecoveryAction | null,
): void {
  const empty = document.querySelector("[data-cart-empty]");
  if (!empty) return;
  const message = empty.querySelector("[data-cart-empty-message]");
  const actions = empty.querySelector("[data-cart-empty-actions]");
  const continueLink = empty.querySelector("[data-cart-empty-continue]");
  empty.querySelector("[data-cart-empty-recovery]")?.remove();
  if (message) {
    message.textContent = recoveryAction
      ? lang.languageData.paymentRecoveryMessageText
      : lang.languageData.emptyCartDescriptionText;
  }
  if (continueLink) continueLink.className = recoveryAction ? SECONDARY : PRIMARY;
  if (recoveryAction) {
    const recoveryLink = document.createElement("a");
    recoveryLink.href = recoveryAction.href;
    recoveryLink.dataset.astroPrefetch = "false";
    recoveryLink.dataset.cartEmptyRecovery = "";
    recoveryLink.className = PRIMARY;
    recoveryLink.textContent = lang.languageData.viewPaymentStatusText;
    actions?.prepend(recoveryLink);
  }
}
