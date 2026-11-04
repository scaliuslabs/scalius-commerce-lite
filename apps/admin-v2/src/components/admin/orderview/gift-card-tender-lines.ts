// The gift-card tenders of an order's payments, as lines the payment summary shows
// (GiftCardTenderRows draws them; the payment card counts the money they hold).
import { getDecimalPlaces } from "@scalius/shared/currency";
import type { OrderPaymentsPayload } from "~/lib/api-query-options/orders";

export type PaymentRow = OrderPaymentsPayload["payments"][number];

interface PaymentGiftCard {
  id: string;
  last4: string;
  storeCredit: boolean;
}

/** The row's gift card (`giftCard` on the payments read), narrowed at runtime. */
export function paymentGiftCard(payment: PaymentRow): PaymentGiftCard | null {
  const value = (payment as { giftCard?: unknown }).giftCard;
  if (!value || typeof value !== "object") return null;
  const card = value as Record<string, unknown>;
  return typeof card.id === "string" && typeof card.last4 === "string"
    ? { id: card.id, last4: card.last4, storeCredit: card.storeCredit === true }
    : null;
}

export interface GiftCardTenderLine {
  key: string;
  kind: "tender" | "storeCredit";
  last4: string;
  currency: string;
  /** Integer minor units: sums never go through floats. */
  amountMinor: number;
  refundedMinor: number;
  state: "held" | "released" | "refunded" | "partlyRefunded";
}

function minorOf(payment: PaymentRow): number {
  return Math.round(payment.amount * 10 ** getDecimalPlaces(payment.currency));
}

/** Tenders (with what was refunded back to each card), then store-credit cards, in ledger order. */
export function giftCardTenderLines(payments: ReadonlyArray<PaymentRow>): GiftCardTenderLine[] {
  const refundedToCard = new Map<string, number>();
  const storeCredits = new Map<string, GiftCardTenderLine>();
  for (const payment of payments) {
    const card = paymentGiftCard(payment);
    if (!card || payment.paymentType !== "refund" || payment.status !== "refunded") continue;
    if (!card.storeCredit) {
      refundedToCard.set(card.id, (refundedToCard.get(card.id) ?? 0) + minorOf(payment));
      continue;
    }
    const line = storeCredits.get(card.id);
    if (line) {
      line.amountMinor += minorOf(payment);
    } else {
      storeCredits.set(card.id, {
        key: `credit:${card.id}`,
        kind: "storeCredit",
        last4: card.last4,
        currency: payment.currency,
        amountMinor: minorOf(payment),
        refundedMinor: 0,
        state: "held",
      });
    }
  }

  const tenders: GiftCardTenderLine[] = [];
  for (const payment of payments) {
    const card = paymentGiftCard(payment);
    if (!card || card.storeCredit || payment.paymentMethod !== "gift_card" || payment.paymentType === "refund") continue;
    if (payment.status !== "succeeded" && payment.status !== "refunded") continue;
    const amountMinor = minorOf(payment);
    const refundedMinor = refundedToCard.get(card.id) ?? 0;
    tenders.push({
      key: payment.id,
      kind: "tender",
      last4: card.last4,
      currency: payment.currency,
      amountMinor,
      refundedMinor,
      state: payment.status === "refunded"
        ? "released"
        : refundedMinor <= 0 ? "held" : refundedMinor >= amountMinor ? "refunded" : "partlyRefunded",
    });
  }
  return [...tenders, ...storeCredits.values()];
}
