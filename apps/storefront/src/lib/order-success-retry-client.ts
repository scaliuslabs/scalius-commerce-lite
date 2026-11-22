// The receipt's payment retry buttons (pages/order-success.astro): start a
// hosted payment or open the card form for the order, say why a press was
// refused, and come back usable when the buyer returns from the gateway.
import { stripeHandler } from "@/lib/checkout/handlers/stripe";
import { pagePath } from "@/lib/presence-url";
import { fetchPaymentSessionWithProcessingRetry } from "@/lib/checkout/payment-session-retry";
import { SLOW_REDIRECT_AFTER_MS } from "@/lib/checkout/loading-overlay";
import { normalizeCheckoutRedirectUrl, normalizeHostedCheckoutUrl } from "@/lib/checkout/redirect-url";
import { writeHostedPaymentRecoverySession } from "@/lib/checkout/session-state";
import type { CheckoutConfig, PaymentContext } from "@/lib/checkout/types";
import { ENGLISH_CHECKOUT_LANGUAGE_DATA, type CheckoutLanguageData } from "@scalius/shared/checkout-language";
import { checkoutText } from "@/lib/checkout-text";
import { buyerApiErrorText } from "@/lib/buyer-api-errors";

/**
 * Why the server now refuses a retry, read from the receipt's status proxy
 * after a press was refused: the session route's own code, or null when a
 * retry is still offered (the press failed for another reason).
 */
async function readRetryRefusal(orderId: string): Promise<string | null> {
  try {
    const response = await fetch(`/api/order-receipt/status?orderId=${encodeURIComponent(orderId)}`, {
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    const payload = await response.json() as { success?: boolean; data?: { retry?: { canRetryPayment?: boolean; refusal?: string | null } } };
    const retry = payload.success ? payload.data?.retry : undefined;
    return retry && retry.canRetryPayment === false && typeof retry.refusal === "string" ? retry.refusal : null;
  } catch {
    return null;
  }
}

export function setupReceiptPaymentRetry(root: Document = document): void {
  const checkoutLanguage = window.__CHECKOUT_LANGUAGE__ as { languageData?: CheckoutLanguageData } | undefined;
  const copy = checkoutLanguage?.languageData ?? ENGLISH_CHECKOUT_LANGUAGE_DATA;
  const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>("[data-payment-retry-button]"));
  const message = root.getElementById("retryPaymentMessage");
  const stripeSection = root.getElementById("stripeSection");
  const stripePayButton = root.getElementById("payButton") as HTMLButtonElement | null;
  if (buttons.length === 0) return;
  /** The server refused for good (an expired checkout, no attempts left): the buttons stay off. */
  let refused = false;

  const setRetryButtonsBusy = (busy: boolean, activeButton?: HTMLButtonElement) => {
    buttons.forEach((retryButton) => {
      retryButton.disabled = busy || refused;
      retryButton.setAttribute("aria-busy", busy && retryButton === activeButton ? "true" : "false");
    });
  };

  // Back from the gateway, the page may be restored as it was left: busy and "Opening payment…".
  window.addEventListener("pageshow", (event) => {
    if (!(event as PageTransitionEvent).persisted) return;
    setRetryButtonsBusy(false);
    if (stripePayButton) stripePayButton.disabled = stripeHandler.isReady?.() !== true;
    if (message) message.textContent = "";
  });

  const showRefusal = async (orderId: string, fallback: string) => {
    const refusal = await readRetryRefusal(orderId);
    if (refusal) {
      refused = true;
      stripeSection?.classList.add("hidden");
    }
    setRetryButtonsBusy(false);
    if (message) message.textContent = refusal ? buyerApiErrorText({ code: refusal }) : fallback;
  };

  const buildRecoveryHref = (orderId: string, gateway: string, paymentType: string, depositAmount: number) => {
    const params = new URLSearchParams({ orderId, payment: gateway });
    if (paymentType) params.set("paymentType", paymentType);
    if (paymentType === "deposit" && Number.isFinite(depositAmount) && depositAmount > 0) {
      params.set("depositAmount", String(depositAmount));
    }
    return pagePath(`/order-success?${params.toString()}`);
  };

  buttons.forEach((button) => button.addEventListener("click", async () => {
    const endpoint = button.dataset.endpoint;
    const gateway = button.dataset.gateway;
    const orderId = button.dataset.orderId;
    const paymentType = button.dataset.paymentType || "full";
    const depositAmount = Number(button.dataset.depositAmount);

    if (!endpoint || !gateway || !orderId) {
      if (message) message.textContent = copy.orderReceiptRetryUnavailableText;
      return;
    }

    if (gateway === "stripe") {
      if (!stripeSection || !stripePayButton) {
        if (message) message.textContent = copy.orderReceiptCardUnavailableText;
        return;
      }
      stripeSection.classList.remove("hidden");
      stripeSection.scrollIntoView({ behavior: "smooth", block: "nearest" });
      setRetryButtonsBusy(true, button);
      if (message) message.textContent = copy.orderReceiptLoadingCardText;
      try {
        await stripeHandler.onSelect?.(stripeSection, copy);
        if (message) message.textContent = copy.orderReceiptEnterCardText;
      } catch {
        if (message) message.textContent = copy.orderReceiptCardLoadFailedText;
      } finally {
        setRetryButtonsBusy(false);
      }
      return;
    }

    stripeSection?.classList.add("hidden");
    setRetryButtonsBusy(true, button);
    if (message) message.textContent = copy.orderReceiptOpeningPaymentText;
    // An app's wallet page can be slow to open on a phone network: say it is
    // still on its way so the buyer waits instead of paying twice.
    const providerName = button.dataset.providerName;
    const slowRedirect = providerName
      ? window.setTimeout(() => {
          if (message) {
            message.textContent = checkoutText(
              copy.redirectSlowMessage || ENGLISH_CHECKOUT_LANGUAGE_DATA.redirectSlowMessage,
              { provider: providerName },
            );
          }
        }, SLOW_REDIRECT_AFTER_MS)
      : undefined;

    try {
      const payload: Record<string, unknown> = {
        orderId,
        paymentType,
        currency: window.__CURRENCY_CODE__ || "BDT",
        replaceExistingAttempt: paymentType !== "balance",
      };
      if (paymentType === "deposit" && Number.isFinite(depositAmount) && depositAmount > 0) {
        payload.depositAmount = depositAmount;
      }

      const { data, response } = await fetchPaymentSessionWithProcessingRetry<Record<string, unknown>>(() => fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }), {
        onProcessing: (event) => {
          if (message) {
            message.textContent = checkoutText(copy.orderReceiptPaymentProcessingRetryText, { seconds: event.retryAfterSeconds });
          }
        },
      });
      if (!response.ok) {
        window.clearTimeout(slowRedirect);
        await showRefusal(orderId, copy.orderReceiptStartPaymentFailedText);
        return;
      }
      const gatewayUrl = normalizeHostedCheckoutUrl(typeof data.gatewayUrl === "string" ? data.gatewayUrl : "");
      if (!gatewayUrl) throw new Error("unsafe_payment_redirect");
      writeHostedPaymentRecoverySession(buildRecoveryHref(orderId, gateway, paymentType, depositAmount), undefined, gateway);
      window.location.href = gatewayUrl;
    } catch (error) {
      window.clearTimeout(slowRedirect);
      setRetryButtonsBusy(false);
      if (message) {
        message.textContent = error instanceof Error && error.message === "unsafe_payment_redirect"
          ? copy.orderReceiptGatewayRedirectFailedText
          : copy.orderReceiptStartPaymentFailedText;
      }
    }
  }));

  stripePayButton?.addEventListener("click", async () => {
    if (!stripeSection) return;
    const orderId = stripeSection.dataset.orderId;
    const paymentType = stripeSection.dataset.paymentType || "full";
    const depositAmount = Number(stripeSection.dataset.depositAmount);
    const totalAmount = Number(stripeSection.dataset.totalAmount);
    const checkoutConfig = window.__CHECKOUT_CONFIG__ as CheckoutConfig | undefined;
    if (!orderId || !checkoutConfig || !Number.isFinite(totalAmount)) {
      if (message) message.textContent = copy.orderReceiptCardUnavailableText;
      return;
    }

    stripePayButton.disabled = true;
    setRetryButtonsBusy(true);
    if (message) message.textContent = copy.orderReceiptConfirmingCardText;
    const context: PaymentContext = {
      checkoutData: {},
      config: checkoutConfig,
      copy,
      orderId,
      totalAmount,
      advanceAmount: paymentType === "deposit" && Number.isFinite(depositAmount) ? depositAmount : 0,
      currencySymbol: window.__CURRENCY_SYMBOL__ || "",
      paymentType: paymentType === "deposit" || paymentType === "balance" ? paymentType : "full",
      depositAmount: paymentType === "deposit" && Number.isFinite(depositAmount) ? depositAmount : undefined,
      replaceExistingAttempt: paymentType !== "balance",
    };

    try {
      const result = await stripeHandler.processPayment(context);
      if (!result.success || !result.redirectUrl) throw new Error("card_payment_failed");
      const redirectUrl = normalizeCheckoutRedirectUrl(result.redirectUrl, window.location.origin);
      if (!redirectUrl) throw new Error("unsafe_receipt_redirect");
      writeHostedPaymentRecoverySession(redirectUrl, undefined, "stripe");
      window.location.href = redirectUrl;
    } catch {
      stripePayButton.disabled = stripeHandler.isReady?.() !== true;
      setRetryButtonsBusy(false);
      if (message) message.textContent = copy.orderReceiptCardPaymentFailedText;
    }
  });
}
