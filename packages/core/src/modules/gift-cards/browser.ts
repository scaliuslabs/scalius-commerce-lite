// Browser-safe entry: pure types and constants only (no database, no domain
// index). Safe to import from the dashboard and from any domain.
// B4 fills the gift-cards domain; these names are the contract it keeps.

/** `gift_cards.status`. Expiry is a separate fact (`expires_at`), not a status. */
export const GIFT_CARD_STATUSES = ["active", "disabled"] as const;
export type GiftCardStatus = (typeof GIFT_CARD_STATUSES)[number];

/** `gift_cards.source`: sold as a product, issued by staff, or refunded as store credit. */
export const GIFT_CARD_SOURCES = ["purchase", "manual", "refund"] as const;
export type GiftCardSource = (typeof GIFT_CARD_SOURCES)[number];

/** `gift_card_transactions.kind`; the ledger is append-only and the balance is its projection. */
export const GIFT_CARD_TRANSACTION_KINDS = ["issue", "redeem", "release", "refund", "adjust"] as const;
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
}
