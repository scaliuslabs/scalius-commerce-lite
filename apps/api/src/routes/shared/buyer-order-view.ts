// The buyer's view of an order (`@scalius/shared/buyer-order-view`) as the
// receipt, the account order and the account orders list send it: one server
// decision the storefront only words.
import { z } from "@hono/zod-openapi";
import {
  BUYER_ORDER_KINDS,
  BUYER_ORDER_STATUS_WORDS,
  buyerOrderDetailView,
  type BuyerOrderDetailView,
} from "@scalius/shared/buyer-order-view";
import { ORDER_PAYMENT_WORDS } from "@scalius/shared/order-payment-words";
import { buyerOrderFacts, type BuyerOrderFactsRow } from "@scalius/core/modules/orders";
import type { CustomerPaymentSessionRecovery } from "../payment/payment-session-create";

export const buyerOrderViewSchema = z.object({
  kind: z.enum(BUYER_ORDER_KINDS),
  status: z.enum(BUYER_ORDER_STATUS_WORDS).openapi({ description: "The order's one status word key, by where it is." }),
  payment: z.enum(ORDER_PAYMENT_WORDS).nullable().openapi({ description: "The shared payment word key (`orderPaymentWord`); null for a payment status the platform does not write." }),
}).openapi("BuyerOrderView");

export const buyerOrderDetailViewSchema = buyerOrderViewSchema.extend({
  refundOnItsWay: z.boolean().openapi({ description: "A refund to the buyer is in flight, one its provider accepted and is completing included." }),
  canRetryPayment: z.boolean().openapi({ description: "A payment session would be accepted now: `paymentRecovery.eligible` with no refund in flight." }),
}).openapi("BuyerOrderDetailView");

export const buyerPaymentRecoverySchema = z.object({
  eligible: z.boolean(),
  gateway: z.string().nullable(),
  paymentType: z.enum(["full", "deposit", "balance"]).nullable(),
  amountDue: z.number(),
  label: z.string().nullable(),
  reason: z.string().nullable(),
  /** The session route's own refusal code, which the buyer pages word. */
  code: z.enum(["checkout_expired", "payment_attempts_exhausted"]).nullable(),
  blockType: z.enum(["validation", "unavailable"]).optional(),
  requiresCardForm: z.boolean(),
  hostedRedirect: z.boolean(),
}).openapi("BuyerPaymentRecovery");

/** The receipt's and the account order's view, from the order row, its payment recovery and its refunds. */
export function presentBuyerOrderDetailView(
  order: BuyerOrderFactsRow,
  paymentRecovery: Pick<CustomerPaymentSessionRecovery, "eligible">,
  refundInFlight: boolean,
): BuyerOrderDetailView {
  return buyerOrderDetailView(buyerOrderFacts(order), { refundInFlight, paymentRecoverable: paymentRecovery.eligible });
}
