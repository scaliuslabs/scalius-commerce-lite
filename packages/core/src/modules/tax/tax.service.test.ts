import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";

const mocks = vi.hoisted(() => ({
  readStoreCurrency: vi.fn(),
}));

vi.mock("../markets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../markets")>();
  return { ...actual, readStoreCurrency: mocks.readStoreCurrency };
});

import { calculateStorefrontTaxQuote } from "./tax.service";

function createTaxDb(): Database {
  const emptyRows: unknown[] = [];
  const chain = {
    where: () => chain,
    leftJoin: () => chain,
    orderBy: async () => emptyRows,
    get: async () => null,
    then: (resolve: (value: unknown[]) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(emptyRows).then(resolve, reject),
  };
  return {
    select: () => ({ from: () => chain }),
    batch: vi.fn(async () => [[], [], []]),
  } as unknown as Database;
}

describe("calculateStorefrontTaxQuote request currency authority", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readStoreCurrency.mockResolvedValue({ code: "JPY", decimalPlaces: 0, priceIncrementMinor: 1 });
  });

  it("uses the supplied KWD authority without re-reading mutable currency settings", async () => {
    const quote = await calculateStorefrontTaxQuote(createTaxDb(), {
      destination: { city: "city_1", zone: "zone_1", area: null },
      lines: [{
        lineId: "line_1",
        productId: "product_1",
        variantId: "variant_1",
        unitPriceMinor: 1_235,
        quantity: 2,
        taxClassId: null,
      }],
      shippingMinor: 1,
      discountMinor: 0,
      currency: { code: "KWD", decimalPlaces: 3, priceIncrementMinor: 1 },
    });

    expect(mocks.readStoreCurrency).not.toHaveBeenCalled();
    expect(quote).toMatchObject({
      currencyCode: "KWD",
      decimalPlaces: 3,
      subtotalMinor: 2_470,
      shippingMinor: 1,
      totalMinor: 2_471,
    });
  });

  it("keeps current-settings fallback for non-request callers", async () => {
    await calculateStorefrontTaxQuote(createTaxDb(), {
      destination: { city: "city_1", zone: "zone_1", area: null },
      lines: [],
      shippingMinor: 0,
      discountMinor: 0,
    });

    expect(mocks.readStoreCurrency).toHaveBeenCalledOnce();
  });
});
