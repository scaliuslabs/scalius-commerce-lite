import type { CheckoutLanguageData, CheckoutLanguageKey } from "@scalius/shared/checkout-language";
import type { GatewayHandler, PaymentContext, PaymentResult } from "../types";
import { createOrder } from "../create-order";
import { CheckoutCopyError } from "../error-messages";
import { fetchPaymentSessionWithProcessingRetry, PaymentSessionProcessingTimeoutError } from "../payment-session-retry";
import { pagePath } from "@/lib/presence-url";
import { paymentFailure } from "./failure";
import { stripeErrorCopyKey, type StripeError } from "../stripe-error";
import { followColorScheme, stripeCardStyle } from "@/lib/stripe-card-style";

export { stripeErrorCopyKey };

declare global {
  interface Window {
    Stripe?: (key: string) => StripeInstance;
  }
}

interface StripeInstance {
  elements(): StripeElements;
  confirmCardPayment(
    clientSecret: string,
    data: { payment_method: { card: StripeCardElement } },
  ): Promise<{
    error?: StripeError;
    paymentIntent?: { status: string };
  }>;
}

interface StripeElements {
  create(
    type: "card",
    options?: { style?: Record<string, Record<string, string | Record<string, string>>> },
  ): StripeCardElement;
}

interface StripeCardElement {
  mount(selector: string): void;
  unmount?(): void;
  destroy?(): void;
  update?(options: { style: ReturnType<typeof stripeCardStyle> }): void;
  on(
    event: "change",
    handler: (e: { complete?: boolean; error?: StripeError & { message: string } }) => void,
  ): void;
  /** The frame rendered and is usable (https://docs.stripe.com/js/element/events/on_ready). */
  on(event: "ready", handler: () => void): void;
  /** The frame failed to load (https://docs.stripe.com/js/element/events/on_loaderror). */
  on(event: "loaderror", handler: (e: { error?: StripeError }) => void): void;
}

/**
 * How long Stripe.js, then the card frame, may take before the form gives up
 * and offers Retry (a frame that never answers otherwise leaves Pay disabled
 * with no explanation).
 */
export const STRIPE_FORM_DEADLINE_MS = 15_000;

let stripeInstance: StripeInstance | null = null;
let stripeCard: StripeCardElement | null = null;
/** Stops restyling the mounted card when the colour scheme changes. */
let stopFollowingScheme: (() => void) | null = null;
let publishableKey: string | null = null;
let stripeCardComplete = false;
let stripeScriptPromise: Promise<void> | null = null;
/** The current card form's load: resolved once its frame is ready; a failure resets it, so Retry starts fresh. */
let stripeCardLoading: Promise<void> | null = null;
/** The current card form's frame answered `ready`. */
let stripeCardReady = false;

/**
 * Stripe.js, within the deadline. Concurrent callers share one pending load;
 * a settled one is forgotten (Stripe is then on the window, or a retry asks again).
 */
function loadStripeScript(): Promise<void> {
  if (window.Stripe) return Promise.resolve();
  stripeScriptPromise ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    const fail = (detail: string) => {
      clearTimeout(deadline);
      script.remove();
      reject(new CheckoutCopyError("cardFormFailedText", detail));
    };
    const deadline = setTimeout(() => fail("Stripe.js did not load in time"), STRIPE_FORM_DEADLINE_MS);
    script.src = "https://js.stripe.com/v3/";
    script.onload = () => {
      clearTimeout(deadline);
      if (window.Stripe) resolve();
      else fail("Stripe.js loaded without Stripe");
    };
    script.onerror = () => fail("Failed to load Stripe.js");
    document.head.appendChild(script);
  }).finally(() => {
    stripeScriptPromise = null;
  });
  return stripeScriptPromise;
}

/** Mounts the card form and waits for its frame: `ready`, else `loaderror` or the deadline refuses it. */
async function mountStripeCard(container: HTMLElement, key: string, copy: CheckoutLanguageData): Promise<void> {
  await loadStripeScript();
  // Another store key took over while Stripe.js loaded: that selection mounts its own form.
  if (publishableKey !== key) throw new CheckoutCopyError("cardFormFailedText", "Stripe key changed while loading");
  stripeInstance = window.Stripe!(key);
  const elements = stripeInstance.elements();
  // The page's colours where the card mounts, again whenever the colour scheme changes.
  const styled = document.getElementById("stripeCardElement") ?? container;
  const card = elements.create("card", { style: stripeCardStyle(styled, "16px") });
  stripeCard = card;
  stopFollowingScheme?.();
  stopFollowingScheme = followColorScheme(styled, "16px", card);
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new CheckoutCopyError("cardFormFailedText", "Stripe card frame did not become ready")), STRIPE_FORM_DEADLINE_MS);
    card.on("ready", () => {
      clearTimeout(deadline);
      resolve();
    });
    card.on("loaderror", () => {
      clearTimeout(deadline);
      reject(new CheckoutCopyError("cardFormFailedText", "Stripe card frame failed to load"));
    });
    card.on("change", (event) => {
      if (stripeCard !== card) return;
      stripeCardComplete = event.complete === true;
      const errEl = document.getElementById("stripeError");
      if (event.error) {
        if (errEl) {
          errEl.textContent = copy[stripeErrorCopyKey(event.error, "cardDetailsIncompleteText")];
          errEl.classList.remove("hidden");
        }
      } else {
        errEl?.classList.add("hidden");
      }
      syncPayButtonReadiness();
    });
    try {
      card.mount("#stripeCardElement");
    } catch (error) {
      clearTimeout(deadline);
      reject(error);
    }
  });
  if (stripeCard === card) stripeCardReady = true;
}

export function resetStripePaymentElement(): void {
  try {
    if (stripeCard?.destroy) stripeCard.destroy();
    else stripeCard?.unmount?.();
  } catch {
    // The prior element may already be detached by browser history restore.
  }
  stripeCard = null;
  stopFollowingScheme?.();
  stopFollowingScheme = null;
  stripeCardLoading = null;
  stripeCardReady = false;
  stripeCardComplete = false;
  const error = document.getElementById("stripeError");
  if (error) {
    error.textContent = "";
    error.classList.add("hidden");
  }
}

function syncPayButtonReadiness(): void {
  const section = document.getElementById("stripeSection");
  if (section?.classList.contains("hidden")) return;
  const button = document.getElementById("payButton") as HTMLButtonElement | null;
  if (button) button.disabled = !stripeCardComplete;
}

export const stripeHandler: GatewayHandler = {
  id: "stripe",
  isReady(): boolean {
    return stripeCardComplete;
  },

  async onSelect(container: HTMLElement, copy: CheckoutLanguageData): Promise<void> {
    // Extract publishable key from the gateway config stored on the container
    const key = container.dataset.publishableKey;
    if (key && key !== publishableKey) {
      publishableKey = key;
      stripeInstance = null;
      resetStripePaymentElement();
    } else if (key) {
      publishableKey = key;
    }

    if (!publishableKey || (stripeCard && stripeCardReady)) return;

    // One load at a time (concurrent selections share it). A frame that
    // fails or never answers is destroyed, so Retry mounts a fresh one.
    const loading = stripeCardLoading ??= mountStripeCard(container, publishableKey, copy).catch((error: unknown) => {
      if (stripeCardLoading === loading) resetStripePaymentElement();
      throw error;
    });
    try {
      await loading;
    } catch (error) {
      throw new CheckoutCopyError("cardFormFailedText", error instanceof Error ? error.message : String(error));
    }
  },

  async processPayment(ctx: PaymentContext): Promise<PaymentResult> {
    if (!stripeCard || !stripeInstance) return paymentFailure(null, ctx, "cardFormLoadingText");
    if (!stripeCardComplete) return paymentFailure(null, ctx, "cardDetailsIncompleteText");

    try {
      const createdOrder = ctx.orderId
        ? { orderId: ctx.orderId, totalAmount: ctx.totalAmount }
        : await createOrder(ctx.checkoutData, "stripe");
      const { orderId } = createdOrder;
      if (!ctx.orderId) ctx.onOrderCreated?.(orderId, "stripe");

      let clientSecret = createdOrder.initialPaymentSession?.gateway === "stripe"
        ? createdOrder.initialPaymentSession.clientSecret
        : undefined;

      if (!clientSecret && createdOrder.initialPaymentSessionError) {
        throw new CheckoutCopyError("paymentStartFailedText", createdOrder.initialPaymentSessionError);
      }

      if (!clientSecret) {
        const intentPayload: Record<string, unknown> = {
          orderId,
          ...(ctx.orderId
            ? {
                paymentType: ctx.paymentType,
                ...(ctx.paymentType === "deposit" && ctx.depositAmount
                  ? { depositAmount: ctx.depositAmount }
                  : {}),
                replaceExistingAttempt: ctx.replaceExistingAttempt ?? true,
              }
            : {}),
        };

        const { data: intentData, response: intentRes } = await fetchPaymentSessionWithProcessingRetry(() => fetch("/api/checkout/payment-session/stripe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(intentPayload),
        }));

        if (!intentRes.ok) throw new CheckoutCopyError("paymentStartFailedText", String(intentData.error ?? intentRes.status));

        clientSecret = typeof intentData.clientSecret === "string" ? intentData.clientSecret : undefined;
      }
      if (!clientSecret) throw new CheckoutCopyError("paymentStartFailedText", "no client secret");

      const { error, paymentIntent } = await stripeInstance.confirmCardPayment(clientSecret, {
        payment_method: { card: stripeCard },
      });

      if (error) throw new CheckoutCopyError(stripeErrorCopyKey(error, "cardPaymentFailedText"), error.message);

      if (paymentIntent?.status === "succeeded" || paymentIntent?.status === "requires_capture") {
        return {
          success: true,
          redirectUrl: pagePath(`/order-success?orderId=${encodeURIComponent(orderId)}&payment=stripe`),
        };
      }

      throw new CheckoutCopyError("cardPaymentFailedText", `payment intent ${paymentIntent?.status ?? "missing"}`);
    } catch (err: unknown) {
      // Still preparing after the bounded retries: the buyer waits, then pays again.
      if (err instanceof PaymentSessionProcessingTimeoutError) return paymentFailure(null, ctx, "paymentPreparingText");
      return paymentFailure(err, ctx, "paymentStartFailedText");
    }
  },
};
