import type { GatewayHandler, PaymentContext, PaymentResult } from "../types";
import { CheckoutOrderError, createOrder } from "../create-order";
import { pagePath } from "@/lib/presence-url";

/**
 * Pay later (`flow: "deferred"`: the store's invoice, net terms, or an app's
 * deferred method): the order is placed now and nothing is charged, like
 * cash on delivery. The API refuses it for a buyer it does not reach.
 */
export function createDeferredGatewayHandler(gateway: string, label: string): GatewayHandler {
  return {
    id: gateway,
    meta: { label, icon: "", desc: "" },

    getButtonText(_isPartialPayment: boolean): string {
      return "Place order";
    },

    async processPayment(ctx: PaymentContext): Promise<PaymentResult> {
      try {
        const { orderId } = await createOrder(ctx.checkoutData, gateway);
        ctx.onOrderCreated?.(orderId, gateway);
        return {
          success: true,
          redirectUrl: pagePath(`/order-success?orderId=${encodeURIComponent(orderId)}`),
        };
      } catch (err: unknown) {
        if (err instanceof CheckoutOrderError) {
          return {
            success: false,
            error: err.message,
            errorCode: err.errorCode,
            details: err.details,
            status: err.status,
            cartIssues: err.cartIssues,
            refusal: err.refusal,
          };
        }
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
