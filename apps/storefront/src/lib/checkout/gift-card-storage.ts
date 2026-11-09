// The applied gift cards a page keeps (sessionStorage: apply handles, last 4
// and balance, never a code) and the `giftCards` field a quote or an order
// carries. Apart from gift-cards.ts (applying a code, its words), so the cart
// page, which only sends the cards already applied, loads no apply flow.
import { MAX_GIFT_CARDS_PER_ORDER } from "@scalius/shared/gift-card-tender";

export { MAX_GIFT_CARDS_PER_ORDER };

/** Cleared with the rest of the checkout transfer (session-state.ts) once an order is placed. */
export const GIFT_CARD_STORAGE_KEY = "scalius_checkout_gift_cards";

/** Mirrors the API's apply-handle shape (`gch_` + sealed base64url); anything else is not a handle. */
export const GIFT_CARD_HANDLE_PATTERN = /^gch_[A-Za-z0-9_-]{40,196}$/;
const LAST4_PATTERN = /^[0-9A-Z]{4}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/** What the checkout page remembers about one applied card. */
export interface StoredGiftCard {
  handle: string;
  last4: string;
  /** Balance when applied (display only; the quote is authoritative). */
  balance: number;
  balanceMinor: number;
  currencyCode: string;
  /** When the handle stops working (ms since epoch); an expired handle is dropped. */
  handleExpiresAt: number;
}

export type GiftCardRequestFields = { giftCards?: Array<{ handle: string }> };

function storageOrNull(storage?: Storage | null): Storage | null {
  if (storage !== undefined) return storage;
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** One stored card, or null when the entry is malformed or its handle has expired. */
export function readStoredGiftCard(value: unknown, now = Date.now()): StoredGiftCard | null {
  if (!isRecord(value)) return null;
  const { handle, last4, currencyCode } = value;
  const balance = finiteNonNegative(value.balance);
  const balanceMinor = finiteNonNegative(value.balanceMinor);
  const handleExpiresAt = finiteNonNegative(value.handleExpiresAt);
  if (
    typeof handle !== "string" || !GIFT_CARD_HANDLE_PATTERN.test(handle) ||
    typeof last4 !== "string" || !LAST4_PATTERN.test(last4) ||
    typeof currencyCode !== "string" || !CURRENCY_PATTERN.test(currencyCode) ||
    balance === null || balanceMinor === null || !Number.isSafeInteger(balanceMinor) ||
    handleExpiresAt === null || handleExpiresAt <= now
  ) {
    return null;
  }
  return { handle, last4, balance, balanceMinor, currencyCode, handleExpiresAt };
}

/** The applied cards in the order the buyer added them (at most five, live handles only). */
export function readStoredGiftCards(storage?: Storage | null, now = Date.now()): StoredGiftCard[] {
  const store = storageOrNull(storage);
  if (!store) return [];
  try {
    const parsed = JSON.parse(store.getItem(GIFT_CARD_STORAGE_KEY) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const cards: StoredGiftCard[] = [];
    for (const entry of parsed) {
      const card = readStoredGiftCard(entry, now);
      if (!card || seen.has(card.handle)) continue;
      seen.add(card.handle);
      cards.push(card);
      if (cards.length === MAX_GIFT_CARDS_PER_ORDER) break;
    }
    return cards;
  } catch {
    return [];
  }
}

export function writeStoredGiftCards(cards: readonly StoredGiftCard[], storage?: Storage | null): void {
  const store = storageOrNull(storage);
  if (!store) return;
  try {
    if (cards.length === 0) store.removeItem(GIFT_CARD_STORAGE_KEY);
    else store.setItem(GIFT_CARD_STORAGE_KEY, JSON.stringify(cards.slice(0, MAX_GIFT_CARDS_PER_ORDER)));
  } catch {
    // Storage is a convenience: the buyer can apply the card again.
  }
}

export function clearStoredGiftCards(storage?: Storage | null): void {
  writeStoredGiftCards([], storage);
}

export type AddGiftCardResult =
  | { ok: true; cards: StoredGiftCard[] }
  | { ok: false; reason: "limit" };

/** Adds a card after the others (cards apply in the order they were added) and stores the list. */
export function addStoredGiftCard(
  cards: readonly StoredGiftCard[],
  card: StoredGiftCard,
  storage?: Storage | null,
): AddGiftCardResult {
  if (cards.length >= MAX_GIFT_CARDS_PER_ORDER) return { ok: false, reason: "limit" };
  const next = [...cards.filter(({ handle }) => handle !== card.handle), card];
  writeStoredGiftCards(next, storage);
  return { ok: true, cards: next };
}

/** Drops the given handles (removed by the buyer or refused by the quote), stores and returns what is left. */
export function removeStoredGiftCards(
  cards: readonly StoredGiftCard[],
  handles: Iterable<string>,
  storage?: Storage | null,
): StoredGiftCard[] {
  const drop = new Set(handles);
  const next = cards.filter((card) => !drop.has(card.handle));
  writeStoredGiftCards(next, storage);
  return next;
}

/** `giftCards` for a tax-quote or order body; nothing at all without cards (the old payload). */
export function giftCardRequestFields(handles: unknown): GiftCardRequestFields {
  if (!Array.isArray(handles)) return {};
  const clean = [...new Set(handles.flatMap((entry) => {
    const handle = isRecord(entry) ? entry.handle : entry;
    return typeof handle === "string" && GIFT_CARD_HANDLE_PATTERN.test(handle) ? [handle] : [];
  }))].slice(0, MAX_GIFT_CARDS_PER_ORDER);
  return clean.length > 0 ? { giftCards: clean.map((handle) => ({ handle })) } : {};
}

