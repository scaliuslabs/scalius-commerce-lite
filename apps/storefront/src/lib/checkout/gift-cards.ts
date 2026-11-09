// Gift cards as a checkout tender (Wave B §4.3, §4.5). After the buyer proves
// a code once (POST /api/gift-cards/apply), the page keeps only the API's
// short-lived apply handle plus what the buyer may see (last 4, balance). The
// handles live in sessionStorage only: never localStorage, a URL, a cookie or
// an analytics payload. The code itself is never stored anywhere.
//
// Every tax quote and the order carry `giftCards: [{handle}]`; the quote says
// what each card pays and what is left (`amountDue`). No handles means the
// request is exactly the pre-gift-card payload.

import { pageDigits } from "@/lib/checkout-text";
import { checkoutRateLimitedText, refusalWaitSeconds } from "@/lib/rate-limit-wait";
import { normalizeGiftCardCode } from "@scalius/shared/gift-card-code";
import type { CheckoutLanguageData } from "@scalius/shared/checkout-language";

export {
  MAX_GIFT_CARDS_PER_ORDER,
  GIFT_CARD_STORAGE_KEY,
  GIFT_CARD_HANDLE_PATTERN,
  readStoredGiftCard,
  readStoredGiftCards,
  writeStoredGiftCards,
  clearStoredGiftCards,
  addStoredGiftCard,
  removeStoredGiftCards,
  giftCardRequestFields,
  type StoredGiftCard,
  type GiftCardRequestFields,
  type AddGiftCardResult,
} from "./gift-card-storage";
import { readStoredGiftCard, type StoredGiftCard } from "./gift-card-storage";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface GiftCardQuoteIssue {
  handle: string | null;
  code: string;
  message: string;
}

/** The buyer's sentence for each issue code the quote reports; other codes use the API's own words. */
const ISSUE_COPY: Record<string, keyof GiftCardCheckoutCopy> = {
  gift_card_unusable: "giftCardUnusableText",
  gift_card_duplicate: "giftCardDuplicateText",
  gift_card_not_needed: "giftCardNotNeededText",
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
  | { ok: false; reason: "invalid" | "unusable" | "unavailable" }
  /** The wait the store named, when it named one. */
  | { ok: false; reason: "rate_limited"; retryAfterSeconds?: number };

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
    if (response.status === 429) {
      const retryAfterSeconds = refusalWaitSeconds(payload, response.headers);
      return { ok: false, reason: "rate_limited", ...(retryAfterSeconds ? { retryAfterSeconds } : {}) };
    }
    if (response.status === 400) return { ok: false, reason: "unusable" };
    return { ok: false, reason: "unavailable" };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

/** What a refused apply tells the buyer: a rate limit says the wait the store named. */
export function giftCardApplyFailureText(
  outcome: Extract<ApplyGiftCardOutcome, { ok: false }>,
  copy: GiftCardCheckoutCopy,
): string {
  switch (outcome.reason) {
    case "invalid": return copy.giftCardEnterCodeText;
    case "unusable": return copy.giftCardUnusableText;
    case "rate_limited": return checkoutRateLimitedText(copy, copy.giftCardRateLimitedText, outcome.retryAfterSeconds);
    default: return copy.giftCardUnavailableText;
  }
}

/** `•••• 7K2Q`, the only part of a code the page shows. */
export function giftCardChipLabel(last4: string): string {
  return `•••• ${pageDigits(last4)}`;
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
  giftCardRateLimitedText: "Too many tries. Please wait before trying again.",
  orderCodeTryAgainInText: "Try again in {time}",
  giftCardUnavailableText: "Gift cards can't be used right now. Try again later.",
  giftCardLineText: "Gift card {card}",
  amountDueText: "Amount due",
  paidWithGiftCardText: "Paid with gift card",
  paidWithGiftCardDescriptionText: "Your gift cards cover the whole order.",
  giftCardPayOnDeliveryText: "Pay {amount} when you receive your order",
  giftCardCheckoutStepText: "Have a gift card? Pay with it on the next step",
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
