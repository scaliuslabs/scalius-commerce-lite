// Browser-safe entry: pure types and constants only (no database, no domain
// index). Safe to import from the dashboard and from any domain.
// B4 fills the gift-cards domain; these names are the contract it keeps.

// The sealed state lists (`gift_cards.status`, `.source`, `gift_card_transactions.kind`),
// as the gift card representations carry them.
import { GIFT_CARD_SOURCES, GIFT_CARD_STATUSES, GIFT_CARD_TRANSACTION_KINDS } from "@scalius/shared/resource-states";

export { GIFT_CARD_SOURCES, GIFT_CARD_STATUSES, GIFT_CARD_TRANSACTION_KINDS };
export type GiftCardStatus = (typeof GIFT_CARD_STATUSES)[number];
export type GiftCardSource = (typeof GIFT_CARD_SOURCES)[number];
export type GiftCardTransactionKind = (typeof GIFT_CARD_TRANSACTION_KINDS)[number];

/** Limits from Wave B design §4 and §11.3. */
export const GIFT_CARD_LIMITS = {
  maxCardsPerOrder: 5,
  maxQuantityPerLine: 20,
  maxUnitsPerOrder: 50,
  maxMessageLength: 200,
  maxNoteLength: 500,
} as const;

/** One card an order line issued (`extras.giftCards[]`); codes are never part of it. */
export interface LineGiftCardExtra {
  giftCardId: string;
  last4: string;
  initialAmountMinor: number;
  currencyCode: string;
  /** The masked recipient contact ("R••••@gmail.com"), or null when sent to the buyer. */
  sentTo: string | null;
  /** Staff only: what the card holds now (a refund takes value back, spending lowers it). */
  balanceMinor?: number;
  /** Staff only: the card was disabled (a refund that took its whole balance disables it). */
  disabled?: boolean;
}
