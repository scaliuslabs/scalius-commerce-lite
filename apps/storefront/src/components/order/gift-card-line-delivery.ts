// Owned by B4 (gift cards): the gift cards an order line issued, as markup for
// the browser-rendered account order page (the receipt renders the same facts
// through GiftCardLineDelivery.astro). Never a code: the last 4, the value and
// where the card was sent (a masked contact from the API). The code reaches the
// recipient by email or SMS, and the owner can show it under Account → Gift cards.
import { escapeHtml } from "@scalius/shared/html-escape";
import { formatMoney } from "@scalius/shared/currency";
import type { LineExtrasContext, OrderLine } from "@/lib/order-line-extras";

/** One issued card, as `extras.giftCards[]` carries it. */
export interface LineGiftCard {
  giftCardId: string;
  last4: string;
  initialAmount: number;
  initialAmountMinor: number;
  currencyCode: string;
  /** Masked recipient contact ("r•••@gmail.com"); null when the card went to the buyer. */
  sentTo: string | null;
}

/** `extras.giftCards` from the API. */
export type GiftCardsExtra = LineGiftCard[];

export const GIFT_CARD_LINE_COPY = {
  card: "Gift card {card} · {amount}",
  sentTo: "Sent to {contact}",
  sentToYou: "Sent to you",
  showCode: "Show code in Gift cards",
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The line's issued cards; malformed entries are skipped, nothing becomes an empty list. */
export function readLineGiftCards(value: unknown): LineGiftCard[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 50).flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const { giftCardId, last4, initialAmount, initialAmountMinor, currencyCode, sentTo } = entry;
    if (
      typeof giftCardId !== "string" || !giftCardId ||
      typeof last4 !== "string" || !/^[0-9A-Z]{4}$/.test(last4) ||
      typeof initialAmount !== "number" || !Number.isFinite(initialAmount) ||
      typeof initialAmountMinor !== "number" || !Number.isSafeInteger(initialAmountMinor) ||
      typeof currencyCode !== "string" || !/^[A-Z]{3}$/.test(currencyCode) ||
      (sentTo !== null && sentTo !== undefined && typeof sentTo !== "string")
    ) {
      return [];
    }
    return [{
      giftCardId,
      last4,
      initialAmount,
      initialAmountMinor,
      currencyCode,
      sentTo: typeof sentTo === "string" && sentTo.trim() ? sentTo.trim().slice(0, 120) : null,
    }];
  });
}

/** "Gift card •••• 7K2Q · ৳500" */
export function lineGiftCardText(card: LineGiftCard): string {
  return GIFT_CARD_LINE_COPY.card
    .replace("{card}", `•••• ${card.last4}`)
    .replace("{amount}", formatMoney(card.initialAmount, { code: card.currencyCode }));
}

/** "Sent to r•••@gmail.com" or "Sent to you". */
export function lineGiftCardDestination(card: LineGiftCard): string {
  return card.sentTo
    ? GIFT_CARD_LINE_COPY.sentTo.replace("{contact}", card.sentTo)
    : GIFT_CARD_LINE_COPY.sentToYou;
}

/** The account may show the code of a card that went to the buyer themself. */
export function lineGiftCardsShowCodeLink(cards: readonly LineGiftCard[], context: LineExtrasContext): boolean {
  return context.access === "account" && cards.some((card) => card.sentTo === null);
}

export function giftCardLineDeliveryMarkup(line: OrderLine, context: LineExtrasContext): string {
  const cards = readLineGiftCards(line.extras?.giftCards);
  if (cards.length === 0) return "";
  const items = cards.map((card) => `
      <li class="flex flex-wrap items-baseline justify-between gap-x-3">
        <span class="font-medium text-foreground">${escapeHtml(lineGiftCardText(card))}</span>
        <span class="text-muted-foreground">${escapeHtml(lineGiftCardDestination(card))}</span>
      </li>`).join("");
  const link = lineGiftCardsShowCodeLink(cards, context)
    ? `<a href="/account/gift-cards" data-astro-prefetch="false" class="inline-flex min-h-11 items-center text-sm font-medium text-primary hover:underline">${escapeHtml(GIFT_CARD_LINE_COPY.showCode)}</a>`
    : "";
  return `<div class="mt-2 text-sm" data-line-gift-cards><ul class="space-y-1">${items}</ul>${link}</div>`;
}
