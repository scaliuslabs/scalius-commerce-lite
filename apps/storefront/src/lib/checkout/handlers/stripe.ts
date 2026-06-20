import type { GatewayHandler, PaymentContext, PaymentResult } from "../types";
import { CheckoutOrderError, createOrder } from "../create-order";

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
  on(event: string, handler: (e: { error?: { message: string } }) => void): void;
}

let stripeInstance: StripeInstance | null = null;
let stripeCard: StripeCardElement | null = null;
let publishableKey: string | null = null;

export const stripeHandler: GatewayHandler = {
  id: "stripe",
  meta: {
    label: "International Payment (Card)",
    icon: `<svg class="w-6 h-6 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
    </svg>`,
    desc: "Visa, Mastercard, American Express",
  },

  getButtonText(_isPartialPayment: boolean): string {
    return "Pay with Card";
  },

  async onSelect(container: HTMLElement): Promise<void> {
    // Extract publishable key from the gateway config stored on the container
    const key = container.dataset.publishableKey;
    if (key) publishableKey = key;

    if (stripeCard || !publishableKey) return;

    try {
      // Dynamically load Stripe.js if not already loaded
      if (!window.Stripe) {
        await new Promise<void>((resolve, reject) => {
          const s = document.createElement("script");
          s.src = "https://js.stripe.com/v3/";
          s.onload = () => resolve();
          s.onerror = () => reject(new Error("Failed to load Stripe.js"));
          document.head.appendChild(s);
        });
      }

      stripeInstance = window.Stripe!(publishableKey);
      const elements = stripeInstance.elements();
      stripeCard = elements.create("card", {
        style: {
          base: { fontSize: "15px", color: "#111", fontFamily: "sans-serif" },
          invalid: { color: "#e53e3e" },
        },
      });
      stripeCard.mount("#stripeCardElement");
      stripeCard.on("change", (event) => {
        const errEl = document.getElementById("stripeError");
        if (event.error) {
          if (errEl) {
            errEl.textContent = event.error.message;
            errEl.classList.remove("hidden");
          }
        } else {
          errEl?.classList.add("hidden");
        }
      });
    } catch {
      throw new Error("Failed to load payment form. Please refresh and try again.");
    }
  },

  async processPayment(ctx: PaymentContext): Promise<PaymentResult> {
    if (!stripeCard || !stripeInstance) {
      return { success: false, error: "Payment form not ready. Please wait a moment." };
    }

    try {
      const createdOrder = await createOrder(ctx.checkoutData, "stripe");
      const { orderId, receiptToken } = createdOrder;

      const intentPayload: Record<string, unknown> = {
        orderId,
        receiptToken,
      };

      const intentRes = await fetch("/api/checkout/stripe-intent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(intentPayload),
      });

      if (!intentRes.ok) {
        const e = await intentRes.json().catch(() => ({} as Record<string, unknown>));
        throw new Error((e.error as string) || "Payment initialization failed");
      }

      const intentData = await intentRes.json();
      const clientSecret = intentData.clientSecret as string;
      if (!clientSecret) throw new Error("No client secret received from payment gateway");

      const { error, paymentIntent } = await stripeInstance.confirmCardPayment(clientSecret, {
        payment_method: { card: stripeCard },
      });

      if (error) throw new Error(error.message || "Card payment failed");

      if (paymentIntent?.status === "succeeded" || paymentIntent?.status === "requires_capture") {
        return {
          success: true,
          redirectUrl: `/order-success?orderId=${encodeURIComponent(orderId)}&token=${encodeURIComponent(receiptToken)}&payment=stripe`,
        };
      }

      throw new Error("Payment was not completed");
    } catch (err: unknown) {
      if (err instanceof CheckoutOrderError) {
        return { success: false, error: err.message, cartIssues: err.cartIssues };
      }
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};
