import type { GatewayHandler, PaymentContext, PaymentResult } from "../types";
import { CheckoutOrderError, createOrder } from "../create-order";
import { resolveCheckoutPaymentRequest } from "../payment-mode";
import { buildPaymentRecoveryUrl } from "../payment-recovery";
import { fetchPaymentSessionWithProcessingRetry } from "../payment-session-retry";
import { normalizeHostedCheckoutUrl } from "../redirect-url";

export const sslcommerzHandler: GatewayHandler = {
  id: "sslcommerz",
  meta: {
    label: "Mobile banking & local cards",
    icon: `<svg class="w-6 h-6 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>`,
    desc: "bKash, Nagad, Rocket, cards, and net banking",
  },

  getButtonText(_isPartialPayment: boolean): string {
    return "Continue to Payment \u2192";
  },

  async processPayment(ctx: PaymentContext): Promise<PaymentResult> {
    let createdOrder: Awaited<ReturnType<typeof createOrder>> | null = null;
    let paymentRequest: ReturnType<typeof resolveCheckoutPaymentRequest> | null = null;
    try {
      createdOrder = await createOrder(ctx.checkoutData, "sslcommerz");
      const { orderId } = createdOrder;
      paymentRequest = resolveCheckoutPaymentRequest(ctx.config, createdOrder.totalAmount ?? ctx.totalAmount);

      let gatewayUrl = createdOrder.initialPaymentSession?.gateway === "sslcommerz"
        ? createdOrder.initialPaymentSession.gatewayUrl
        : undefined;

      if (!gatewayUrl && createdOrder.initialPaymentSessionError) {
        throw new Error(createdOrder.initialPaymentSessionError);
      }

      if (!gatewayUrl) {
        const sessionPayload: Record<string, unknown> = {
          orderId,
        };

        const { data: sessionData, response: sessionRes } = await fetchPaymentSessionWithProcessingRetry(() => fetch("/api/checkout/sslcommerz-session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(sessionPayload),
        }));

        if (!sessionRes.ok) {
          const e = sessionData;
          throw new Error((e.error as string) || "Payment gateway initialization failed");
        }
        gatewayUrl = typeof sessionData.gatewayUrl === "string" ? sessionData.gatewayUrl : undefined;
      }
      gatewayUrl = normalizeHostedCheckoutUrl(gatewayUrl) ?? undefined;
      if (!gatewayUrl) throw new Error("Payment gateway returned an unsafe checkout URL");
      const hostedPaymentRecoveryUrl = buildPaymentRecoveryUrl({
        orderId,
        gateway: "sslcommerz",
        paymentType: paymentRequest?.paymentType,
        depositAmount: paymentRequest?.paymentType === "deposit" ? paymentRequest.depositAmount : undefined,
      });

      return {
        success: true,
        redirectUrl: gatewayUrl,
        clearCartOnRedirect: true,
        hostedPaymentRecoveryUrl,
      };
    } catch (err: unknown) {
      if (createdOrder) {
        const hostedPaymentRecoveryUrl = buildPaymentRecoveryUrl({
          orderId: createdOrder.orderId,
          gateway: "sslcommerz",
          paymentType: paymentRequest?.paymentType,
          depositAmount: paymentRequest?.paymentType === "deposit" ? paymentRequest.depositAmount : undefined,
        });
        return {
          success: true,
          redirectUrl: hostedPaymentRecoveryUrl,
          clearCartOnRedirect: true,
          hostedPaymentRecoveryUrl,
        };
      }
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
