import type { GatewayHandler, PaymentContext, PaymentResult } from "../types";
import { CheckoutOrderError, createOrder } from "../create-order";

export const codHandler: GatewayHandler = {
  id: "cod",
  meta: {
    label: "Cash on delivery",
    icon: "",
    desc: "Pay when you receive your order",
  },

  getButtonText(_isPartialPayment: boolean): string {
    return "Place order";
  },

  async processPayment(ctx: PaymentContext): Promise<PaymentResult> {
    try {
      const { orderId } = await createOrder(ctx.checkoutData, "cod");
      ctx.onOrderCreated?.(orderId, "cod");
      return {
        success: true,
        redirectUrl: `/order-success?orderId=${encodeURIComponent(orderId)}`,
      };
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
