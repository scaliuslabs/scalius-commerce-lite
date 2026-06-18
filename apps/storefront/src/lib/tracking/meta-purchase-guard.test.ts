// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "vitest";

import {
  claimMetaPurchaseTracking,
  createPurchaseEventId,
} from "./meta-purchase-guard";

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();

  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(values.keys())[index] ?? null;
    },
    removeItem(key: string) {
      values.delete(key);
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
}

describe("Meta purchase tracking guard", () => {
  beforeEach(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: createMemoryStorage(),
    });
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      value: createMemoryStorage(),
    });
  });

  it("uses a stable Purchase event id derived from the order id", () => {
    expect(createPurchaseEventId("order_1")).toBe("Purchase:order_1");
  });

  it("claims a purchase only once per browser storage", () => {
    const firstClaim = claimMetaPurchaseTracking("order_1");
    const secondClaim = claimMetaPurchaseTracking("order_1");

    expect(firstClaim).toEqual({
      shouldSend: true,
      eventId: "Purchase:order_1",
    });
    expect(secondClaim).toEqual({
      shouldSend: false,
      eventId: "Purchase:order_1",
    });
  });
});
