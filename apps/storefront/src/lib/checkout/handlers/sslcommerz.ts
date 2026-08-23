import type { GatewayHandler, PaymentContext, PaymentResult } from "../types";
import { CheckoutOrderError, createOrder } from "../create-order";
import { resolveCheckoutPaymentRequest, resolveExplicitCheckoutPaymentRequest } from "../payment-mode";
import { buildPaymentRecoveryUrl } from "../payment-recovery";
import { fetchPaymentSessionWithProcessingRetry } from "../payment-session-retry";
import { normalizeHostedCheckoutUrl } from "../redirect-url";

export const sslcommerzHandler: GatewayHandler = {
  id: "sslcommerz",
  meta: {
    label: "Pay online",
    icon: "",
    desc: "bKash, Nagad, cards and more",
  },

  getButtonText(_isPartialPayment: boolean): string {
    return "Continue to SSLCommerz";
  },

  async processPayment(ctx: PaymentContext): Promise<PaymentResult> {
    let createdOrder: Awaited<ReturnType<typeof createOrder>> | null = null;
    let paymentRequest: ReturnType<typeof resolveCheckoutPaymentRequest> | null = null;
    try {
      createdOrder = ctx.orderId
        ? { orderId: ctx.orderId, totalAmount: ctx.totalAmount }
        : await createOrder(ctx.checkoutData, "sslcommerz");
      const { orderId } = createdOrder;
      if (!ctx.orderId) ctx.onOrderCreated?.(orderId, "sslcommerz");
      paymentRequest = ctx.paymentType
        ? resolveExplicitCheckoutPaymentRequest(ctx.paymentType, ctx.depositAmount)
        : resolveCheckoutPaymentRequest(ctx.config, createdOrder.totalAmount ?? ctx.totalAmount);

      let gatewayUrl = createdOrder.initialPaymentSession?.gateway === "sslcommerz"
        ? createdOrder.initialPaymentSession.gatewayUrl
        : undefined;

      if (!gatewayUrl && createdOrder.initialPaymentSessionError) {
        throw new Error(createdOrder.initialPaymentSessionError);
      }

      if (!gatewayUrl) {
        const sessionPayload: Record<string, unknown> = {
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
