import { describe, expect, it } from "vitest";

import {
  BLOCKING_GIFT_CARD_TENDER_ISSUES,
  computeGiftCardTender,
  GIFT_CARD_MAX_QUANTITY_PER_LINE,
  GIFT_CARD_MAX_UNITS_PER_ORDER,
  GiftCardTenderInputError,
  isGiftCardLineQuantityAllowed,
  isGiftCardOrderUnitsAllowed,
  isGiftCardTenderBlocked,
  MAX_GIFT_CARDS_PER_ORDER,
  type GiftCardTenderInput,
} from "./gift-card-tender";

const base: GiftCardTenderInput = { totalMinor: 0, giftCardLineTotalMinor: 0, cards: [], depositPlan: false };

describe("computeGiftCardTender", () => {
  it("applies nothing without cards", () => {
    expect(computeGiftCardTender({ ...base, totalMinor: 1_500 })).toEqual({
      eligibleMinor: 1_500,
      applied: [],
      appliedTotalMinor: 0,
      amountDueMinor: 1_500,
      issues: [],
    });
  });

  it("applies cards in buyer order, each min(balance, eligible remaining)", () => {
    const tender = computeGiftCardTender({
      ...base,
      totalMinor: 1_000,
      cards: [{ id: "gc_a", balanceMinor: 300 }, { id: "gc_b", balanceMinor: 900 }, { id: "gc_c", balanceMinor: 50 }],
    });
    expect(tender.applied).toEqual([{ id: "gc_a", appliedMinor: 300 }, { id: "gc_b", appliedMinor: 700 }]);
    expect(tender.appliedTotalMinor).toBe(1_000);
    expect(tender.amountDueMinor).toBe(0);
    expect(tender.issues).toEqual([{ code: "card_not_applied", id: "gc_c", reason: "nothing_left_to_pay" }]);
    expect(isGiftCardTenderBlocked(tender)).toBe(false);
  });

  it("leaves a remainder for COD or a gateway", () => {
    const tender = computeGiftCardTender({ ...base, totalMinor: 2_500, cards: [{ id: "gc_a", balanceMinor: 500 }] });
    expect(tender.applied).toEqual([{ id: "gc_a", appliedMinor: 500 }]);
    expect(tender.amountDueMinor).toBe(2_000);
  });

  it("never pays for gift-card lines", () => {
    const tender = computeGiftCardTender({
      ...base,
      totalMinor: 3_000,
      giftCardLineTotalMinor: 2_000,
      cards: [{ id: "gc_a", balanceMinor: 5_000 }],
    });
    expect(tender.eligibleMinor).toBe(1_000);
    expect(tender.applied).toEqual([{ id: "gc_a", appliedMinor: 1_000 }]);
    expect(tender.amountDueMinor).toBe(2_000);

    const onlyGiftCards = computeGiftCardTender({
      ...base,
      totalMinor: 2_000,
      giftCardLineTotalMinor: 2_000,
      cards: [{ id: "gc_a", balanceMinor: 5_000 }],
    });
    expect(onlyGiftCards.applied).toEqual([]);
    expect(onlyGiftCards.amountDueMinor).toBe(2_000);
    expect(onlyGiftCards.issues).toEqual([{ code: "card_not_applied", id: "gc_a", reason: "nothing_left_to_pay" }]);
  });

  it("clamps eligibility at zero when gift-card lines exceed the total", () => {
    const tender = computeGiftCardTender({
      ...base,
      totalMinor: 100,
      giftCardLineTotalMinor: 500,
      cards: [{ id: "gc_a", balanceMinor: 100 }],
    });
    expect(tender.eligibleMinor).toBe(0);
    expect(tender.applied).toEqual([]);
    expect(tender.amountDueMinor).toBe(100);
  });

  it("reports zero-balance and duplicate cards without applying them", () => {
    const tender = computeGiftCardTender({
      ...base,
      totalMinor: 1_000,
      cards: [{ id: "gc_zero", balanceMinor: 0 }, { id: "gc_a", balanceMinor: 400 }, { id: "gc_a", balanceMinor: 400 }],
    });
    expect(tender.applied).toEqual([{ id: "gc_a", appliedMinor: 400 }]);
    expect(tender.amountDueMinor).toBe(600);
    expect(tender.issues).toEqual([
      { code: "card_not_applied", id: "gc_zero", reason: "zero_balance" },
      { code: "duplicate_card", id: "gc_a" },
    ]);
    expect(isGiftCardTenderBlocked(tender)).toBe(false);
  });

  it("refuses a deposit plan with gift cards and applies nothing", () => {
    const tender = computeGiftCardTender({
      ...base,
      totalMinor: 1_000,
      depositPlan: true,
      cards: [{ id: "gc_a", balanceMinor: 400 }],
    });
    expect(tender.applied).toEqual([]);
    expect(tender.amountDueMinor).toBe(1_000);
    expect(tender.issues).toEqual([{ code: "deposit_plan_with_gift_cards" }]);
    expect(isGiftCardTenderBlocked(tender)).toBe(true);
    expect(computeGiftCardTender({ ...base, totalMinor: 1_000, depositPlan: true }).issues).toEqual([]);
  });

  it("refuses more than five cards and applies nothing", () => {
    const cards = Array.from({ length: MAX_GIFT_CARDS_PER_ORDER + 1 }, (_, index) => ({ id: `gc_${index}`, balanceMinor: 100 }));
    const tender = computeGiftCardTender({ ...base, totalMinor: 10_000, cards });
    expect(tender.applied).toEqual([]);
    expect(tender.issues).toEqual([{ code: "too_many_cards", max: 5 }]);
    expect(isGiftCardTenderBlocked(tender)).toBe(true);
    expect(computeGiftCardTender({ ...base, totalMinor: 10_000, cards: cards.slice(0, 5) }).applied).toHaveLength(5);
  });

  it("rejects money that is not non-negative integer minor units", () => {
    const bad: GiftCardTenderInput[] = [
      { ...base, totalMinor: 10.5 },
      { ...base, totalMinor: -1 },
      { ...base, totalMinor: Number.NaN },
      { ...base, totalMinor: Number.MAX_SAFE_INTEGER + 1 },
      { ...base, giftCardLineTotalMinor: -5 },
      { ...base, cards: [{ id: "gc_a", balanceMinor: 1.25 }] },
      { ...base, cards: [{ id: "gc_a", balanceMinor: -100 }] },
      { ...base, cards: [{ id: "", balanceMinor: 100 }] },
    ];
    for (const input of bad) expect(() => computeGiftCardTender(input)).toThrow(GiftCardTenderInputError);
  });

  it("holds the G3 invariants for random carts (property test)", () => {
    const random = seededRandom(0x5ca1);
    const int = (max: number) => Math.floor(random() * (max + 1));
    for (let run = 0; run < 2_000; run += 1) {
      const totalMinor = int(3) === 0 ? 0 : int(200_000);
      const giftCardLineTotalMinor = int(2) === 0 ? 0 : int(totalMinor + 1_000);
      const ids = ["gc_a", "gc_b", "gc_c", "gc_d", "gc_e", "gc_f", "gc_g"];
      const cards = Array.from({ length: int(7) }, () => ({
        id: ids[int(ids.length - 1)]!,
        balanceMinor: int(4) === 0 ? 0 : int(100_000),
      }));
      const input: GiftCardTenderInput = { totalMinor, giftCardLineTotalMinor, cards, depositPlan: int(5) === 0 };
      const tender = computeGiftCardTender(input);
      const blocked = isGiftCardTenderBlocked(tender);

      // Money is conserved in integers.
      const sum = tender.applied.reduce((total, entry) => total + entry.appliedMinor, 0);
      expect(tender.appliedTotalMinor).toBe(sum);
      expect(tender.amountDueMinor).toBe(totalMinor - sum);
      for (const value of [tender.eligibleMinor, tender.appliedTotalMinor, tender.amountDueMinor]) {
        expect(Number.isSafeInteger(value) && value >= 0).toBe(true);
      }
      // A gift card never pays for gift cards.
      expect(tender.eligibleMinor).toBe(Math.max(0, totalMinor - giftCardLineTotalMinor));
      expect(tender.appliedTotalMinor).toBeLessThanOrEqual(tender.eligibleMinor);
      // At most five cards, each applied once, positive and within its balance, in buyer order.
      expect(tender.applied.length).toBeLessThanOrEqual(MAX_GIFT_CARDS_PER_ORDER);
      expect(new Set(tender.applied.map((entry) => entry.id)).size).toBe(tender.applied.length);
      const firstIndex = (id: string) => cards.findIndex((card) => card.id === id);
      for (const [index, entry] of tender.applied.entries()) {
        const card = cards[firstIndex(entry.id)]!;
        expect(entry.appliedMinor).toBeGreaterThan(0);
        expect(entry.appliedMinor).toBeLessThanOrEqual(card.balanceMinor);
        if (index > 0) expect(firstIndex(entry.id)).toBeGreaterThan(firstIndex(tender.applied[index - 1]!.id));
      }
      // Greedy: a card applies less than its balance only when it exhausts eligibility.
      const partial = tender.applied.filter((entry) => entry.appliedMinor < cards[firstIndex(entry.id)]!.balanceMinor);
      if (partial.length > 0) {
        expect(partial).toEqual([tender.applied[tender.applied.length - 1]]);
        expect(tender.appliedTotalMinor).toBe(tender.eligibleMinor);
      }
      // Deposit plans and more than five cards block and apply nothing.
      if (input.depositPlan && cards.length > 0) {
        expect(blocked).toBe(true);
        expect(tender.applied).toEqual([]);
      }
      if (cards.length > MAX_GIFT_CARDS_PER_ORDER) {
        expect(blocked).toBe(true);
        expect(tender.applied).toEqual([]);
      }
      if (blocked) expect(tender.appliedTotalMinor).toBe(0);
      // Every listed card is either applied or explained.
      if (!blocked) {
        const explained = new Set(tender.issues.flatMap((issue) => ("id" in issue ? [issue.id] : [])));
        for (const card of cards) {
          expect(tender.applied.some((entry) => entry.id === card.id) || explained.has(card.id)).toBe(true);
        }
      }
    }
  });

  it("names the blocking issues", () => {
    expect(BLOCKING_GIFT_CARD_TENDER_ISSUES).toEqual(["too_many_cards", "deposit_plan_with_gift_cards"]);
  });
});

describe("gift-card quantity caps", () => {
  it("caps a line at 20 units and an order at 50", () => {
    expect(GIFT_CARD_MAX_QUANTITY_PER_LINE).toBe(20);
    expect(GIFT_CARD_MAX_UNITS_PER_ORDER).toBe(50);
    expect(isGiftCardLineQuantityAllowed(1)).toBe(true);
    expect(isGiftCardLineQuantityAllowed(20)).toBe(true);
    expect(isGiftCardLineQuantityAllowed(21)).toBe(false);
    expect(isGiftCardLineQuantityAllowed(0)).toBe(false);
    expect(isGiftCardLineQuantityAllowed(2.5)).toBe(false);
    expect(isGiftCardOrderUnitsAllowed(50)).toBe(true);
    expect(isGiftCardOrderUnitsAllowed(51)).toBe(false);
  });
});

/** Mulberry32: a deterministic PRNG so a failing property run reproduces. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}
