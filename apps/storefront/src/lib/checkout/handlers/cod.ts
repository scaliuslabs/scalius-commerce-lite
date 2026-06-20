import type { GatewayHandler, PaymentContext, PaymentResult } from "../types";
import { CheckoutOrderError, createOrder } from "../create-order";

export const codHandler: GatewayHandler = {
  id: "cod",
  meta: {
    label: "Cash on Delivery",
    icon: `<svg class="w-6 h-6 text-slate-700" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z" />
    </svg>`,
    desc: "Pay when your order arrives",
  },

  getButtonText(_isPartialPayment: boolean): string {
    return "Place Order \u2014 Pay on Delivery";
  },

  async processPayment(ctx: PaymentContext): Promise<PaymentResult> {
    try {
      const { orderId, receiptToken } = await createOrder(ctx.checkoutData, "cod");
      return {
        success: true,
        redirectUrl: `/order-success?orderId=${encodeURIComponent(orderId)}&token=${encodeURIComponent(receiptToken)}`,
        clearCartOnRedirect: true,
      };
    } catch (err: unknown) {
      if (err instanceof CheckoutOrderError) {
        return { success: false, error: err.message, cartIssues: err.cartIssues };
      }
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};
