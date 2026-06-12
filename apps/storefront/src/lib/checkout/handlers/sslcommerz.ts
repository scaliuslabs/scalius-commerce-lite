import type { GatewayHandler, PaymentContext, PaymentResult } from "../types";
import { createOrder } from "../create-order";

export const sslcommerzHandler: GatewayHandler = {
  id: "sslcommerz",
  meta: {
    label: "Bangladeshi Payment (BDT)",
    icon: `<svg class="w-6 h-6 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>`,
    desc: "bKash, Nagad, Rocket, Local Cards, Net Banking",
  },

  getButtonText(_isPartialPayment: boolean): string {
    return "Continue to Payment \u2192";
  },

  async processPayment(ctx: PaymentContext): Promise<PaymentResult> {
    try {
      const { orderId, receiptToken } = await createOrder(ctx.checkoutData, "sslcommerz");

      const sessionPayload: Record<string, unknown> = {
        orderId,
        receiptToken,
        currency: (window as unknown as Record<string, unknown>).__CURRENCY_CODE__ || "BDT",
        paymentType: ctx.config.partialPaymentEnabled ? "deposit" : "full",
      };
      if (ctx.config.partialPaymentEnabled) {
        sessionPayload.depositAmount = ctx.config.partialPaymentAmount;
      }

      const sessionRes = await fetch("/api/checkout/sslcommerz-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sessionPayload),
      });

      if (!sessionRes.ok) {
        const e = await sessionRes.json().catch(() => ({} as Record<string, unknown>));
        throw new Error((e.error as string) || "Payment gateway initialization failed");
      }

      const sessionData = await sessionRes.json();
      const gatewayUrl = sessionData.gatewayUrl as string;
      if (!gatewayUrl) throw new Error("No gateway URL received");

      return { success: true, redirectUrl: gatewayUrl };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};
