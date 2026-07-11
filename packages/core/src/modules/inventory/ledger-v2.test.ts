import { describe, expect, it } from "vitest";
import {
  buildInventoryLedgerV2Edge,
  foldInventoryLedgerV2,
  getActiveReservationGeneration,
  getNextReservationGeneration,
  getReservationGenerationBalances,
  InventoryLedgerDiscontinuityError,
  type InventoryLedgerPool,
  type InventoryLedgerV2Event,
} from "./ledger-v2";

function event(
  overrides: Partial<InventoryLedgerV2Event> & Pick<InventoryLedgerV2Event, "id">,
): InventoryLedgerV2Event {
  const { id, ...rest } = overrides;
  return {
    id,
    variantId: "variant_1",
    orderId: "order_1",
    type: "reserved",
    pool: "regular",
    reservationGeneration: 1,
    stockVersionBefore: 1,
    stockVersionAfter: 2,
    previousStock: 10,
    newStock: 10,
    stockDelta: 0,
    previousReservedStock: 0,
    newReservedStock: 2,
    reservedStockDelta: 2,
    previousPreorderStock: 4,
    newPreorderStock: 4,
    preorderStockDelta: 0,
    ...rest,
  };
}

describe("inventory ledger v2", () => {
  it("builds a complete version edge from counter snapshots", () => {
    expect(buildInventoryLedgerV2Edge({
      pool: "preorder",
      reservationGeneration: 2,
      before: { stock: 10, reservedStock: 1, preorderStock: 5, stockVersion: 7 },
      after: { stock: 10, reservedStock: 3, preorderStock: 3, stockVersion: 8 },
    })).toEqual({
      ledgerVersion: 2,
      pool: "preorder",
      reservationGeneration: 2,
      stockVersionBefore: 7,
      stockVersionAfter: 8,
      previousStock: 10,
      newStock: 10,
      stockDelta: 0,
      previousReservedStock: 1,
      newReservedStock: 3,
      reservedStockDelta: 2,
      previousPreorderStock: 5,
      newPreorderStock: 3,
      preorderStockDelta: -2,
    });
  });

  it("folds a regular reserve, partial release, and deduction without losing outstanding units", () => {
    const events = [
      event({ id: "reserve", reservedStockDelta: 5, newReservedStock: 5 }),
      event({
        id: "partial-release",
        type: "released",
        stockVersionBefore: 2,
        stockVersionAfter: 3,
        previousReservedStock: 5,
        newReservedStock: 3,
        reservedStockDelta: -2,
      }),
      event({
        id: "deduct-rest",
        type: "deducted",
        stockVersionBefore: 3,
        stockVersionAfter: 4,
        previousStock: 10,
        newStock: 7,
        stockDelta: -3,
        previousReservedStock: 3,
        newReservedStock: 0,
        reservedStockDelta: -3,
      }),
    ];

    expect(foldInventoryLedgerV2(
      { stock: 10, reservedStock: 0, preorderStock: 4, stockVersion: 1 },
      events,
    )).toEqual({ stock: 7, reservedStock: 0, preorderStock: 4, stockVersion: 4 });

    expect(getReservationGenerationBalances(events, {
      orderId: "order_1",
      variantId: "variant_1",
      pool: "regular",
    })).toEqual([{ generation: 1, reserved: 5, consumed: 5, outstanding: 0 }]);
  });

  it.each([
    ["regular", 0, 2, 0],
    ["backorder", 0, 2, 0],
    ["preorder", 0, 2, -2],
  ] satisfies Array<[InventoryLedgerPool, number, number, number]>) (
    "tracks a %s reservation with explicit counter deltas",
    (pool, stockDelta, reservedStockDelta, preorderStockDelta) => {
      const movement = event({
        id: `${pool}-reserve`,
        pool,
        stockDelta,
        reservedStockDelta,
        preorderStockDelta,
        newReservedStock: 2,
        newPreorderStock: 4 + preorderStockDelta,
      });

      expect(foldInventoryLedgerV2(
        { stock: 10, reservedStock: 0, preorderStock: 4, stockVersion: 1 },
        [movement],
      )).toEqual({
        stock: 10,
        reservedStock: 2,
        preorderStock: 4 + preorderStockDelta,
        stockVersion: 2,
      });
    },
  );

  it("keeps a partially consumed generation active and advances only after it closes", () => {
    const openEvents = [
      event({ id: "reserve", reservedStockDelta: 5, newReservedStock: 5 }),
      event({
        id: "release-two",
        type: "released",
        stockVersionBefore: 2,
        stockVersionAfter: 3,
        previousReservedStock: 5,
        newReservedStock: 3,
        reservedStockDelta: -2,
      }),
    ];
    const openBalances = getReservationGenerationBalances(openEvents, {
      orderId: "order_1",
      variantId: "variant_1",
      pool: "regular",
    });

    expect(getActiveReservationGeneration(openBalances)).toBe(1);
    expect(getNextReservationGeneration(openBalances)).toBe(1);

    const closedBalances = getReservationGenerationBalances([
      ...openEvents,
      event({
        id: "release-rest",
        type: "released",
        stockVersionBefore: 3,
        stockVersionAfter: 4,
        previousReservedStock: 3,
        newReservedStock: 0,
        reservedStockDelta: -3,
      }),
    ], {
      orderId: "order_1",
      variantId: "variant_1",
      pool: "regular",
    });

    expect(getActiveReservationGeneration(closedBalances)).toBeNull();
    expect(getNextReservationGeneration(closedBalances)).toBe(2);
  });

  it("rejects a gap in the stock-version sequence", () => {
    expect(() => foldInventoryLedgerV2(
      { stock: 10, reservedStock: 0, preorderStock: 4, stockVersion: 1 },
      [event({ id: "gap", stockVersionBefore: 2, stockVersionAfter: 3 })],
    )).toThrow(InventoryLedgerDiscontinuityError);
  });

  it("rejects a delta that disagrees with its snapshots", () => {
    expect(() => foldInventoryLedgerV2(
      { stock: 10, reservedStock: 0, preorderStock: 4, stockVersion: 1 },
      [event({ id: "bad-delta", stockDelta: 1 })],
    )).toThrow("stock delta does not match");
  });
});
