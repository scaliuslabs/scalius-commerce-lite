import type { GatewayHandler, PaymentContext, PaymentResult } from "../types";
import { CheckoutOrderError, createOrder } from "../create-order";
import { resolveCheckoutPaymentRequest } from "../payment-mode";
import { buildPaymentRecoveryUrl } from "../payment-recovery";

export const polarHandler: GatewayHandler = {
  id: "polar",
  meta: {
    label: "Global Digital Payment",
    icon: `<svg class="w-6 h-6 text-indigo-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M13 10V3L4 14h7v7l9-11h-7z" />
    </svg>`,
    desc: "Any Cards or Cash App",
  },

  getButtonText(_isPartialPayment: boolean): string {
    return "Continue to Payment \u2192";
  },

  async processPayment(ctx: PaymentContext): Promise<PaymentResult> {
    let createdOrder: Awaited<ReturnType<typeof createOrder>> | null = null;
    let paymentRequest: ReturnType<typeof resolveCheckoutPaymentRequest> | null = null;
    try {
      createdOrder = await createOrder(ctx.checkoutData, "polar");
      const { orderId, receiptToken } = createdOrder;
      paymentRequest = resolveCheckoutPaymentRequest(ctx.config, createdOrder.totalAmount ?? ctx.totalAmount);

      const sessionPayload: Record<string, unknown> = {
        orderId,
        receiptToken,
      };

      const sessionRes = await fetch("/api/checkout/polar-session", {
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

      return {
        success: true,
        redirectUrl: gatewayUrl,
        clearCheckoutSessionOnRedirect: true,
      };
    } catch (err: unknown) {
      if (createdOrder) {
        return {
          success: true,
          redirectUrl: buildPaymentRecoveryUrl({
            orderId: createdOrder.orderId,
            receiptToken: createdOrder.receiptToken,
            gateway: "polar",
            paymentType: paymentRequest?.paymentType,
            depositAmount: paymentRequest?.paymentType === "deposit" ? paymentRequest.depositAmount : undefined,
          }),
          clearCheckoutSessionOnRedirect: true,
        };
      }
      if (err instanceof CheckoutOrderError) {
        return { success: false, error: err.message, cartIssues: err.cartIssues };
      }
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};
