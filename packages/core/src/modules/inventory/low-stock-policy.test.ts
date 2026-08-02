import { describe, expect, it } from "vitest";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import {
  buildInventoryLowStockCondition,
  isLowStockThresholdEnabled,
} from "./low-stock-policy";

describe("low-stock policy", () => {
  it.each([
    [null, false],
    [undefined, false],
    [0, false],
    [-1, false],
    [Number.NaN, false],
    [5, true],
  ])("treats threshold %s enabled=%s", (threshold, expected) => {
    expect(isLowStockThresholdEnabled(threshold)).toBe(expected);
  });

  it("requires an explicit positive threshold in inventory list and stats SQL", () => {
    const query = new SQLiteSyncDialect().sqlToQuery(
      buildInventoryLowStockCondition(),
    );

    expect(query.sql.toLowerCase()).toContain("low_stock_threshold\" is not null");
    expect(query.sql.toLowerCase()).toContain("low_stock_threshold\" > 0");
    expect(query.sql.toLowerCase()).not.toMatch(
      /coalesce\(\s*"product_variants"\."low_stock_threshold"/,
    );
    expect(query.params).toEqual([]);
  });
});
