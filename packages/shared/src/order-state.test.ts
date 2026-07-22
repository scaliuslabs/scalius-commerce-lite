import { describe, expect, it } from "vitest";
import { canProcessOrderCodAction } from "./order-state";

describe("order COD action policy", () => {
  it("allows collection only from delivery-capable order states", () => {
    expect(canProcessOrderCodAction("confirmed", "collected")).toBe(true);
    expect(canProcessOrderCodAction("shipped", "collected")).toBe(true);
    expect(canProcessOrderCodAction("delivered", "collected")).toBe(true);
    expect(canProcessOrderCodAction("pending", "collected")).toBe(false);
    expect(canProcessOrderCodAction("cancelled", "collected")).toBe(false);
    expect(canProcessOrderCodAction("completed", "collected")).toBe(false);
  });

  it("keeps failed attempts and returns inside their operational states", () => {
    expect(canProcessOrderCodAction("confirmed", "failed")).toBe(true);
    expect(canProcessOrderCodAction("shipped", "failed")).toBe(true);
    expect(canProcessOrderCodAction("delivered", "failed")).toBe(false);
    expect(canProcessOrderCodAction("cancelled", "failed")).toBe(false);

    expect(canProcessOrderCodAction("shipped", "returned")).toBe(true);
    expect(canProcessOrderCodAction("delivered", "returned")).toBe(true);
    expect(canProcessOrderCodAction("completed", "returned")).toBe(true);
    expect(canProcessOrderCodAction("cancelled", "returned")).toBe(false);
    expect(canProcessOrderCodAction("unknown", "returned")).toBe(false);
  });
});
