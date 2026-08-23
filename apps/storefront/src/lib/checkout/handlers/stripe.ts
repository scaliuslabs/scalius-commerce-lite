import type { GatewayHandler, PaymentContext, PaymentResult } from "../types";
import { CheckoutOrderError, createOrder } from "../create-order";
import { fetchPaymentSessionWithProcessingRetry } from "../payment-session-retry";

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
    error?: { message?: string };
    paymentIntent?: { status: string };
  }>;
}

interface StripeElements {
  create(
    type: "card",
    options?: { style?: Record<string, Record<string, string>> },
  ): StripeCardElement;
}

interface StripeCardElement {
  mount(selector: string): void;
  unmount?(): void;
  destroy?(): void;
  on(
    event: "change",
    handler: (e: { complete?: boolean; error?: { message: string } }) => void,
  ): void;
}

let stripeInstance: StripeInstance | null = null;
let stripeCard: StripeCardElement | null = null;
let publishableKey: string | null = null;
let stripeCardComplete = false;
let stripeScriptPromise: Promise<void> | null = null;

export function resetStripePaymentElement(): void {
  try {
    if (stripeCard?.destroy) stripeCard.destroy();
    else stripeCard?.unmount?.();
  } catch {
    // The prior element may already be detached by browser history restore.
  }
  stripeCard = null;
  stripeCardComplete = false;
}

function syncPayButtonReadiness(): void {
  const section = document.getElementById("stripeSection");
  if (section?.classList.contains("hidden")) return;
  const button = document.getElementById("payButton") as HTMLButtonElement | null;
  if (button) button.disabled = !stripeCardComplete;
}

export const stripeHandler: GatewayHandler = {
  id: "stripe",
  meta: {
    label: "Credit or debit card",
    icon: "",
    desc: "Pay securely by card",
  },

  getButtonText(_isPartialPayment: boolean): string {
    return "Pay by card";
  },

  isReady(): boolean {
    return stripeCardComplete;
  },

  async onSelect(container: HTMLElement): Promise<void> {
    // Extract publishable key from the gateway config stored on the container
    const key = container.dataset.publishableKey;
    if (key && key !== publishableKey) {
      publishableKey = key;
      stripeInstance = null;
      resetStripePaymentElement();
    } else if (key) {
      publishableKey = key;
    }

    if (stripeCard || !publishableKey) return;

    try {
      // Dynamically load Stripe.js if not already loaded
      if (!window.Stripe) {
        stripeScriptPromise ??= new Promise<void>((resolve, reject) => {
          const script = document.createElement("script");
          script.src = "https://js.stripe.com/v3/";
          script.onload = () => resolve();
          script.onerror = () => reject(new Error("Failed to load Stripe.js"));
          document.head.appendChild(script);
        }).catch((error) => {
          stripeScriptPromise = null;
          throw error;
        });
        await stripeScriptPromise;
      }

      stripeInstance = window.Stripe!(publishableKey);
      const elements = stripeInstance.elements();
      stripeCard = elements.create("card", {
        style: {
          base: { fontSize: "16px", color: "#111", fontFamily: "sans-serif" },
          invalid: { color: "#e53e3e" },
        },
      });
      stripeCard.mount("#stripeCardElement");
      stripeCard.on("change", (event) => {
        stripeCardComplete = event.complete === true;
        const errEl = document.getElementById("stripeError");
        if (event.error) {
          if (errEl) {
            errEl.textContent = event.error.message;
            errEl.classList.remove("hidden");
          }
        } else {
          errEl?.classList.add("hidden");
        }
        syncPayButtonReadiness();
      });
    } catch {
      throw new Error("Failed to load payment form. Please refresh and try again.");
    }
  },

  async processPayment(ctx: PaymentContext): Promise<PaymentResult> {
    if (!stripeCard || !stripeInstance) {
      return { success: false, error: "Payment form not ready. Please wait a moment." };
    }
    if (!stripeCardComplete) {
      return { success: false, error: "Complete your card details before paying." };
    }

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
        throw new Error(createdOrder.initialPaymentSessionError);
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

        const { data: intentData, response: intentRes } = await fetchPaymentSessionWithProcessingRetry(() => fetch("/api/checkout/stripe-intent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(intentPayload),
        }));

        if (!intentRes.ok) {
          const e = intentData;
          throw new Error((e.error as string) || "Payment initialization failed");
        }

        clientSecret = typeof intentData.clientSecret === "string" ? intentData.clientSecret : undefined;
      }
      if (!clientSecret) throw new Error("No client secret received from payment gateway");

      const { error, paymentIntent } = await stripeInstance.confirmCardPayment(clientSecret, {
        payment_method: { card: stripeCard },
      });

      if (error) throw new Error(error.message || "Card payment failed");

      if (paymentIntent?.status === "succeeded" || paymentIntent?.status === "requires_capture") {
        return {
          success: true,
          redirectUrl: `/order-success?orderId=${encodeURIComponent(orderId)}&payment=stripe`,
        };
      }

      throw new Error("Payment was not completed");
    } catch (err: unknown) {
      if (err instanceof CheckoutOrderError) {
        return {
          success: false,
          error: err.message,
          errorCode: err.errorCode,
          status: err.status,
          cartIssues: err.cartIssues,
        };
      }
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};
