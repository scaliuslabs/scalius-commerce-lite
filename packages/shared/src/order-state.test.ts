import { describe, expect, it } from "vitest";
import { canProcessOrderCodAction } from "./order-state";

describe("order COD action policy", () => {
  it("allows collection only once the order is out for delivery", () => {
    expect(canProcessOrderCodAction("confirmed", "collected")).toBe(false);
    expect(canProcessOrderCodAction("shipped", "collected")).toBe(true);
    expect(canProcessOrderCodAction("delivered", "collected")).toBe(true);
    expect(canProcessOrderCodAction("pending", "collected")).toBe(false);
    expect(canProcessOrderCodAction("cancelled", "collected")).toBe(false);
    expect(canProcessOrderCodAction("completed", "collected")).toBe(false);
  });

  it("keeps failed attempts and returns inside their operational states", () => {
    expect(canProcessOrderCodAction("confirmed", "failed")).toBe(false);
    expect(canProcessOrderCodAction("shipped", "failed")).toBe(true);
    expect(canProcessOrderCodAction("delivered", "failed")).toBe(false);
    expect(canProcessOrderCodAction("cancelled", "failed")).toBe(false);

    expect(canProcessOrderCodAction("shipped", "returned")).toBe(true);
    expect(canProcessOrderCodAction("delivered", "returned")).toBe(true);
    expect(canProcessOrderCodAction("completed", "returned")).toBe(false);
    expect(canProcessOrderCodAction("cancelled", "returned")).toBe(false);
    expect(canProcessOrderCodAction("unknown", "returned")).toBe(false);
  });

  it("collects cash from a confirmed order only when nothing ships (pickup counter or service)", () => {
    expect(canProcessOrderCodAction("confirmed", "collected", { requiresShipping: false })).toBe(true);
    expect(canProcessOrderCodAction("delivered", "collected", { requiresShipping: false })).toBe(true);
    expect(canProcessOrderCodAction("confirmed", "collected", { requiresShipping: true })).toBe(false);
    expect(canProcessOrderCodAction("pending", "collected", { requiresShipping: false })).toBe(false);
    expect(canProcessOrderCodAction("confirmed", "failed", { requiresShipping: false })).toBe(false);
    expect(canProcessOrderCodAction("confirmed", "returned", { requiresShipping: false })).toBe(false);
  });
});
