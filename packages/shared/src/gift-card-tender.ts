/**
 * Gift cards as a tender (Wave B §4.3): the one pricing rule cart validation,
 * the tax quote and checkout commit share, so the amount a buyer sees is the
 * amount commit debits. Pure and integer-only (minor units).
 *
 * - `eligible = total − gift-card line totals`: a gift card never pays for a
 *   gift card (anti-laundering).
 * - Cards apply in the order the buyer added them, each
 *   `min(balance, eligible remaining)`.
 * - `amountDue = total − Σ applied`. Tender is payment, not a discount: it
 *   never changes taxes or discounts, so callers pass the final order total.
 * - At most 5 cards; a deposit/partial-payment plan cannot be combined with
 *   gift cards. Either one blocks the order and applies no card at all.
 *
 * Currency, status, expiry and balance freshness are the caller's job (the
 * apply lookup and the commit trigger guard); this function only splits money.
 */

export const MAX_GIFT_CARDS_PER_ORDER = 5;
/** Gift-card units per cart line and per order (auto-fulfil statement budget, §11.3). */
export const GIFT_CARD_MAX_QUANTITY_PER_LINE = 20;
export const GIFT_CARD_MAX_UNITS_PER_ORDER = 50;

export interface GiftCardTenderCard {
  id: string;
  /** Current balance in minor units (≥ 0). */
  balanceMinor: number;
}

export interface GiftCardTenderInput {
  /** The final order total in minor units, after discounts, shipping and tax. */
  totalMinor: number;
  /** Σ line totals of gift-card lines in the same order (0 when none). */
  giftCardLineTotalMinor: number;
  /** The buyer's cards, in the order they were added. */
  cards: readonly GiftCardTenderCard[];
  /** Whether the buyer chose a deposit/partial-payment plan. */
  depositPlan: boolean;
}

export interface GiftCardTenderApplication {
  id: string;
  /** Always > 0: cards that apply nothing are reported in `issues`, never here. */
  appliedMinor: number;
}

export type GiftCardTenderIssue =
  /** More than `MAX_GIFT_CARDS_PER_ORDER` cards. Blocking: no card applies. */
  | { code: "too_many_cards"; max: number }
  /** A deposit plan with gift cards. Blocking: no card applies. */
  | { code: "deposit_plan_with_gift_cards" }
  /** The same card listed again; the later entry is ignored. */
  | { code: "duplicate_card"; id: string }
  /** The card applies nothing: its balance is 0, or earlier cards already cover the eligible amount. */
  | { code: "card_not_applied"; id: string; reason: "zero_balance" | "nothing_left_to_pay" };

export type GiftCardTenderIssueCode = GiftCardTenderIssue["code"];

/** Issues that make the order unplaceable until the buyer changes the cards or the plan. */
export const BLOCKING_GIFT_CARD_TENDER_ISSUES = [
  "too_many_cards",
  "deposit_plan_with_gift_cards",
] as const satisfies readonly GiftCardTenderIssueCode[];

export interface GiftCardTender {
  /** What gift cards may pay: total minus gift-card lines, never below 0. */
  eligibleMinor: number;
  /** Positive applications in buyer order: exactly the `redeem` debits commit writes. */
  applied: GiftCardTenderApplication[];
  appliedTotalMinor: number;
  /** `totalMinor − appliedTotalMinor`: what COD or a gateway collects. */
  amountDueMinor: number;
  issues: GiftCardTenderIssue[];
}

/** Thrown for input that is not integer minor units; a programming error, never buyer input. */
export class GiftCardTenderInputError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = "GiftCardTenderInputError";
  }
}

function assertMinor(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new GiftCardTenderInputError(`${name} must be a non-negative integer in minor units.`);
  }
}

/** The tender split for an order (§4.3). Throws `GiftCardTenderInputError` on non-integer or negative money. */
export function computeGiftCardTender(input: GiftCardTenderInput): GiftCardTender {
  assertMinor("totalMinor", input.totalMinor);
  assertMinor("giftCardLineTotalMinor", input.giftCardLineTotalMinor);
  for (const card of input.cards) {
    if (typeof card.id !== "string" || card.id.length === 0) {
      throw new GiftCardTenderInputError("Every gift card needs an id.");
    }
    assertMinor(`balanceMinor of ${card.id}`, card.balanceMinor);
  }

  const eligibleMinor = Math.max(0, input.totalMinor - input.giftCardLineTotalMinor);
  const unapplied = (issues: GiftCardTenderIssue[]): GiftCardTender => ({
    eligibleMinor,
    applied: [],
    appliedTotalMinor: 0,
    amountDueMinor: input.totalMinor,
    issues,
  });

  if (input.cards.length === 0) return unapplied([]);
  if (input.depositPlan) return unapplied([{ code: "deposit_plan_with_gift_cards" }]);
  if (input.cards.length > MAX_GIFT_CARDS_PER_ORDER) {
    return unapplied([{ code: "too_many_cards", max: MAX_GIFT_CARDS_PER_ORDER }]);
  }

  const applied: GiftCardTenderApplication[] = [];
  const issues: GiftCardTenderIssue[] = [];
  const seen = new Set<string>();
  let remaining = eligibleMinor;
  for (const card of input.cards) {
    if (seen.has(card.id)) {
      issues.push({ code: "duplicate_card", id: card.id });
      continue;
    }
    seen.add(card.id);
    if (card.balanceMinor === 0) {
      issues.push({ code: "card_not_applied", id: card.id, reason: "zero_balance" });
      continue;
    }
    const appliedMinor = Math.min(card.balanceMinor, remaining);
    if (appliedMinor === 0) {
      issues.push({ code: "card_not_applied", id: card.id, reason: "nothing_left_to_pay" });
      continue;
    }
    applied.push({ id: card.id, appliedMinor });
    remaining -= appliedMinor;
  }

  const appliedTotalMinor = eligibleMinor - remaining;
  return {
    eligibleMinor,
    applied,
    appliedTotalMinor,
    amountDueMinor: input.totalMinor - appliedTotalMinor,
    issues,
  };
}

/** Whether the order cannot be placed with these cards as they stand. */
export function isGiftCardTenderBlocked(tender: GiftCardTender): boolean {
  return tender.issues.some((issue) =>
    (BLOCKING_GIFT_CARD_TENDER_ISSUES as readonly GiftCardTenderIssueCode[]).includes(issue.code));
}

/** Whether a cart line quantity of gift cards is within the per-line cap. */
export function isGiftCardLineQuantityAllowed(quantity: number): boolean {
  return Number.isSafeInteger(quantity) && quantity >= 1 && quantity <= GIFT_CARD_MAX_QUANTITY_PER_LINE;
}

/** Whether the total gift-card units in one order are within the per-order cap. */
export function isGiftCardOrderUnitsAllowed(units: number): boolean {
  return Number.isSafeInteger(units) && units >= 0 && units <= GIFT_CARD_MAX_UNITS_PER_ORDER;
}
