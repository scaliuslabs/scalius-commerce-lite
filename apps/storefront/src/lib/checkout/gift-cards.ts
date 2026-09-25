// Gift cards as a checkout tender (Wave B §4.3, §4.5). After the buyer proves
// a code once (POST /api/gift-cards/apply), the page keeps only the API's
// short-lived apply handle plus what the buyer may see (last 4, balance). The
// handles live in sessionStorage only: never localStorage, a URL, a cookie or
// an analytics payload. The code itself is never stored anywhere.
//
// Every tax quote and the order carry `giftCards: [{handle}]`; the quote says
// what each card pays and what is left (`amountDue`). No handles means the
// request is exactly the pre-gift-card payload.

import { normalizeGiftCardCode } from "@scalius/shared/gift-card-code";
import { MAX_GIFT_CARDS_PER_ORDER } from "@scalius/shared/gift-card-tender";
import type { CheckoutLanguageData } from "@scalius/shared/checkout-language";

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

export interface GiftCardQuoteIssue {
  handle: string | null;
  code: string;
  message: string;
}

/** The buyer's sentence for each issue code the quote reports; other codes use the API's own words. */
const ISSUE_COPY: Record<string, keyof GiftCardCheckoutCopy> = {
  GIFT_CARD_UNUSABLE: "giftCardUnusableText",
  GIFT_CARD_DUPLICATE: "giftCardDuplicateText",
  GIFT_CARD_NOT_NEEDED: "giftCardNotNeededText",
};

/**
 * The quote's word on the applied cards: every card it names in an issue
 * (unusable, a duplicate, or not needed because earlier cards cover the
 * order) leaves the list, and the buyer gets one sentence for the first
 * issue. An order-level issue (`handle` null) keeps the cards and says why.
 */
export function giftCardQuoteRefusal(
  cards: readonly StoredGiftCard[],
  issues: readonly GiftCardQuoteIssue[] | undefined,
  copy: GiftCardCheckoutCopy,
): { remaining: StoredGiftCard[]; dropped: string[]; message: string | null } {
  const applied = new Set(cards.map(({ handle }) => handle));
  const relevant = (issues ?? []).filter(({ handle }) => handle === null || applied.has(handle));
  const dropped = [...new Set(relevant.flatMap(({ handle }) => (handle ? [handle] : [])))];
  const remaining = cards.filter(({ handle }) => !dropped.includes(handle));
  const first = relevant[0];
  const key = first ? ISSUE_COPY[first.code] : undefined;
  return { remaining, dropped, message: first ? (key ? copy[key] : first.message) : null };
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

/** A successful apply from the storefront proxy, as the page stores it. */
export function readAppliedGiftCard(value: unknown, now = Date.now()): StoredGiftCard | null {
  if (!isRecord(value)) return null;
  const expiresAt = typeof value.handleExpiresAt === "string" ? Date.parse(value.handleExpiresAt) : NaN;
  return readStoredGiftCard({
    handle: value.handle,
    last4: value.last4,
    balance: value.balance,
    balanceMinor: value.balanceMinor,
    currencyCode: value.currencyCode,
    handleExpiresAt: Number.isFinite(expiresAt) ? expiresAt : null,
  }, now);
}

export type ApplyGiftCardOutcome =
  | { ok: true; card: StoredGiftCard }
  | { ok: false; reason: "invalid" | "unusable" | "rate_limited" | "unavailable" };

const APPLY_ENDPOINT = "/api/gift-cards/apply";
const APPLY_TIMEOUT_MS = 10_000;

/**
 * Proves a code once through the same-origin proxy (POST body only). The
 * caller stores the returned handle; the code is not kept.
 */
export async function requestGiftCardApply(
  code: string,
  fetcher: typeof fetch = fetch,
): Promise<ApplyGiftCardOutcome> {
  const canonical = normalizeGiftCardCode(code);
  if (!canonical) return { ok: false, reason: "invalid" };
  try {
    const response = await fetcher(APPLY_ENDPOINT, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ code: canonical }),
      cache: "no-store",
      credentials: "same-origin",
      signal: AbortSignal.timeout(APPLY_TIMEOUT_MS),
    });
    const payload = await response.json().catch(() => null) as { success?: unknown; data?: unknown } | null;
    if (response.ok && payload?.success === true) {
      const card = readAppliedGiftCard(payload.data);
      return card ? { ok: true, card } : { ok: false, reason: "unavailable" };
    }
    if (response.status === 429) return { ok: false, reason: "rate_limited" };
    if (response.status === 400) return { ok: false, reason: "unusable" };
    return { ok: false, reason: "unavailable" };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

/** `•••• 7K2Q`, the only part of a code the page shows. */
export function giftCardChipLabel(last4: string): string {
  return `•••• ${last4}`;
}

// ── Copy ─────────────────────────────────────────────────────────────────────

/**
 * Gift-card checkout strings: keys of `@scalius/shared/checkout-language`
 * (en + bn presets, merchant-editable). The resolved language always carries
 * them; these English defaults (the en preset, kept equal by a test) only
 * cover a language object without them, and keep the presets out of browser
 * bundles that import this module.
 */
export const GIFT_CARD_CHECKOUT_COPY = {
  giftCardTitleText: "Gift card",
  giftCardCodeLabelText: "Gift card code",
  giftCardApplyText: "Apply",
  giftCardApplyingText: "Applying…",
  giftCardRemoveText: "Remove gift card {card}",
  giftCardAppliedText: "Gift card {card} applied.",
  giftCardRemovedText: "Gift card {card} removed.",
  giftCardEnterCodeText: "Enter the 16-character code from your gift card.",
  giftCardUnusableText: "This gift card can't be used.",
  giftCardDuplicateText: "This gift card is already applied.",
  giftCardNotNeededText: "Your other gift cards already cover this order, so this one wasn't used.",
  giftCardLimitText: "You can use up to 5 gift cards on one order.",
  giftCardChangedText: "Your gift card balance changed; review and place the order again.",
  giftCardRateLimitedText: "Too many tries. Wait a minute, then try again.",
  giftCardUnavailableText: "Gift cards can't be used right now. Try again later.",
  giftCardLineText: "Gift card {card}",
  amountDueText: "Amount due",
  paidWithGiftCardText: "Paid with gift card",
  paidWithGiftCardDescriptionText: "Your gift cards cover the whole order.",
  giftCardPayOnDeliveryText: "Pay {amount} when you receive your order",
  giftCardCheckoutStepText: "Have a gift card? Use it on the payment step",
} as const satisfies Partial<CheckoutLanguageData>;

export type GiftCardCheckoutCopy = { -readonly [Key in keyof typeof GIFT_CARD_CHECKOUT_COPY]: string };

export function giftCardCheckoutCopy(
  languageData?: Partial<CheckoutLanguageData> | Record<string, unknown> | null,
): GiftCardCheckoutCopy {
  const source = (languageData ?? {}) as Record<string, unknown>;
  const copy = { ...GIFT_CARD_CHECKOUT_COPY } as GiftCardCheckoutCopy;
  for (const key of Object.keys(GIFT_CARD_CHECKOUT_COPY) as Array<keyof GiftCardCheckoutCopy>) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) copy[key] = value;
  }
  return copy;
}
