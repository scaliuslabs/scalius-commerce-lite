import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { PromotionAggregate } from "~/lib/api-functions/promotions";
import { getPromotionOperationalStatus, PromotionStatusBadge } from "./PromotionStatusBadge";

function promotion(overrides: Partial<PromotionAggregate> = {}): PromotionAggregate {
  return {
    id: "promo_1",
    revision: 1,
    name: "Launch",
    title: null,
    method: "code",
    status: "active",
    priority: 100,
    conflictPolicy: "best",
    startsAtEpochSeconds: null,
    endsAtEpochSeconds: null,
    timezone: "Asia/Dhaka",
    maxRedemptions: null,
    maxRedemptionsPerCustomer: null,
    maxDiscountSpendMinor: null,
    budgetCurrencyCode: null,
    redemptionCount: 0,
    customerRedemptionCount: 0,
    discountSpendMinor: 0,
    createdAtEpochSeconds: 1,
    updatedAtEpochSeconds: 1,
    deletedAtEpochSeconds: null,
    codes: [{ code: "LAUNCH", isActive: true }],
    conditions: [],
    effects: [{
      id: "effect_1",
      kind: "percentage_off",
      target: "order",
      allocation: "once",
      config: { basisPoints: 1000 },
    }],
    ...overrides,
  } as PromotionAggregate;
}

describe("promotion status presentation", () => {
  it("distinguishes a future active schedule from a currently active rule", () => {
    expect(getPromotionOperationalStatus(
      promotion({ startsAtEpochSeconds: 200 }),
      100,
    ).label).toBe("Scheduled");
    expect(getPromotionOperationalStatus(promotion(), 100).label).toBe("Active");
  });

  it("renders a compact explicit lifecycle badge", () => {
    const html = renderToStaticMarkup(
      <PromotionStatusBadge promotion={promotion({ status: "paused" })} />,
    );
    expect(html).toContain("Paused");
    expect(html).toContain("amber");
  });
});
