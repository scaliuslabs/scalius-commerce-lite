import type { GatewayHandler, PaymentContext, PaymentResult } from "../types";
import { CheckoutOrderError, createOrder } from "../create-order";

/** The payment method of an order the buyer's gift cards pay in full. */
export const GIFT_CARD_PAYMENT_METHOD = "gift_card";

/**
 * Gift cards cover the whole order (the quote's amount due is 0 and the only
 * allowed method is `gift_card`): place the order, nothing else to collect.
 */
export const giftCardHandler: GatewayHandler = {
  id: GIFT_CARD_PAYMENT_METHOD,
  meta: {
    label: "Paid with gift card",
    icon: "",
    desc: "Your gift cards cover the whole order",
  },

  getButtonText(_isPartialPayment: boolean): string {
    return "Place order";
  },

  async processPayment(ctx: PaymentContext): Promise<PaymentResult> {
    try {
      const { orderId } = await createOrder(ctx.checkoutData, GIFT_CARD_PAYMENT_METHOD);
      ctx.onOrderCreated?.(orderId, GIFT_CARD_PAYMENT_METHOD);
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
