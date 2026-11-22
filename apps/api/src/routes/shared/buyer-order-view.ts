// The buyer's view of an order (`@scalius/shared/buyer-order-view`) as the
// receipt, the account order, the account orders list and the order lookup
// send it: one server decision the storefront only words.
import { z } from "@hono/zod-openapi";
import {
  BUYER_ORDER_KINDS,
  BUYER_ORDER_STATUS_WORDS,
  BUYER_PAYMENT_ACTIONS,
  buyerOrderDetailView,
  type BuyerOrderDetailView,
} from "@scalius/shared/buyer-order-view";
import { ORDER_PAYMENT_WORDS } from "@scalius/shared/order-payment-words";
import { buyerOrderFacts, type BuyerOrderFactsRow } from "@scalius/core/modules/orders";
import { PAYMENT_RECOVERY_REFUSALS, type CustomerPaymentSessionRecovery } from "../payment/payment-session-create";

export const buyerOrderViewSchema = z.object({
  kind: z.enum(BUYER_ORDER_KINDS),
  status: z.enum(BUYER_ORDER_STATUS_WORDS).openapi({ description: "The order's one status word key, by where it is and how it reaches the buyer." }),
  payment: z.enum(ORDER_PAYMENT_WORDS).nullable().openapi({ description: "The shared payment word key (`orderPaymentWord`); null for a payment status the platform does not write. A lookup never sees a dispute." }),
}).openapi("BuyerOrderView");

export const buyerOrderDetailViewSchema = buyerOrderViewSchema.extend({
  refundOnItsWay: z.boolean().openapi({ description: "A refund to the buyer is in flight, one its provider accepted and is completing included." }),
  paymentAction: z.enum(BUYER_PAYMENT_ACTIONS).nullable().openapi({
    description: "The payment the buyer may make now: `retry` a pending or failed payment, `pay_balance` the rest of a placed order early; null when the session route would start none.",
  }),
}).openapi("BuyerOrderDetailView");

export const buyerPaymentRecoverySchema = z.object({
  eligible: z.boolean(),
  gateway: z.string().nullable().openapi({ description: "The method a payment starts first." }),
  gateways: z.array(z.string()).openapi({ description: "Every method a session would be accepted for, the order's own first." }),
  paymentType: z.enum(["full", "deposit", "balance"]).nullable(),
  amountDue: z.number(),
  refusal: z.enum(PAYMENT_RECOVERY_REFUSALS).nullable().openapi({ description: "Why no session would start, a code the storefront words; null exactly when eligible." }),
  requiresCardForm: z.boolean(),
  hostedRedirect: z.boolean(),
}).openapi("BuyerPaymentRecovery");

/** The receipt's and the account order's view, from the order row, its payment recovery and its refunds. */
export function presentBuyerOrderDetailView(
  order: BuyerOrderFactsRow,
  proof: "receipt" | "account",
  paymentRecovery: Pick<CustomerPaymentSessionRecovery, "eligible"> | null,
  refundInFlight: boolean,
): BuyerOrderDetailView {
  return buyerOrderDetailView(buyerOrderFacts(order), proof, { refundInFlight, paymentRecoverable: paymentRecovery?.eligible === true });
}
