import { describe, expect, it } from "vitest";

import {
  addPromotionCodes,
  buildPromotionPayload,
  createPromotionDraft,
  epochSecondsToZonedLocal,
  majorToMinor,
  promotionUsageSummary,
  zonedLocalToEpochSeconds,
} from "./promotion-editor-model";

describe("promotion editor model", () => {
  it("normalizes unique bulk codes and rejects unsupported identities", () => {
    const result = addPromotionCodes(
      [{ code: "WELCOME10", isActive: true }],
      " welcome10, VIP_20\nnot.ok  AB ",
    );

    expect(result.codes).toEqual([
      { code: "WELCOME10", isActive: true },
      { code: "VIP_20", isActive: true },
    ]);
    expect(result.rejected).toEqual(["NOT.OK", "AB"]);
  });

  it("converts decimal merchant amounts without floating point drift", () => {
    expect(majorToMinor("10.05", "BDT")).toBe(1005);
    expect(majorToMinor("10.005", "BDT")).toBeNull();
    expect(majorToMinor("500", "JPY")).toBe(500);
  });

  it("presents committed promotion usage against merchant budgets", () => {
    expect(promotionUsageSummary({
      redemptionCount: 1,
      maxRedemptions: 100,
      discountSpendMinor: 102_800,
      maxDiscountSpendMinor: 10_000_000,
      budgetCurrencyCode: "BDT",
    }, "৳")).toEqual({
      uses: "1 / 100 uses",
      spend: "৳1028 / ৳100000",
    });
    expect(promotionUsageSummary({
      redemptionCount: 0,
      maxRedemptions: null,
      discountSpendMinor: 0,
      maxDiscountSpendMinor: null,
      budgetCurrencyCode: null,
    }, "৳")).toEqual({ uses: "0 uses", spend: null });
  });

  it("round trips schedule wall time through the selected timezone", () => {
    const epoch = zonedLocalToEpochSeconds("2026-07-20T09:30", "Asia/Dhaka");
    expect(epoch).not.toBeNull();
    expect(epochSecondsToZonedLocal(epoch, "Asia/Dhaka")).toBe("2026-07-20T09:30");
  });

  it("builds only the evaluator capabilities represented by the editor", () => {
    const draft = createPromotionDraft("BDT");
    draft.name = "Launch offer";
    draft.codes = [{ code: "launch-10", isActive: true }];
    draft.minimumSubtotal = "1000";
    draft.minimumQuantity = "2";
    draft.effects.order = { enabled: true, kind: "percentage_off", value: "12.5" };
    draft.effects.shipping = { enabled: true, kind: "free", value: "" };
    draft.maxRedemptions = "100";
    draft.maxRedemptionsPerCustomer = "1";
    draft.maxDiscountSpend = "5000";

    const result = buildPromotionPayload(draft);
    expect(result.readiness.saveIssues).toEqual([]);
    expect(result.input).toMatchObject({
      method: "code",
      priority: 100,
      conflictPolicy: "best",
      codes: [{ code: "LAUNCH-10", isActive: true }],
      conditions: [
        {
          kind: "minimum_merchandise_subtotal",
          config: { amountMinor: 100_000, currencyCode: "BDT" },
        },
        { kind: "minimum_item_quantity", config: { quantity: 2 } },
      ],
      effects: [
        {
          kind: "percentage_off",
          target: "order",
          allocation: "once",
          config: { basisPoints: 1250 },
        },
        { kind: "free", target: "shipping", allocation: "once", config: {} },
      ],
      maxRedemptions: 100,
      maxRedemptionsPerCustomer: 1,
      maxDiscountSpendMinor: 500_000,
      budgetCurrencyCode: "BDT",
    });
  });

  it("keeps draft saving distinct from activation readiness", () => {
    const draft = createPromotionDraft("BDT");
    draft.name = "Paused codes";
    draft.codes = [{ code: "PAUSED10", isActive: false }];

    const result = buildPromotionPayload(draft);
    expect(result.input).not.toBeNull();
    expect(result.readiness.saveIssues).toEqual([]);
    expect(result.readiness.activationIssues).toEqual([
      { field: "codes", message: "Enable at least one checkout code." },
    ]);
  });
});
