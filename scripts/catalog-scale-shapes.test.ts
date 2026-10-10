import { describe, expect, it } from "vitest";
// @ts-expect-error - plain .mjs module shared with the seed script
import * as shapes from "./catalog-scale-shapes.mjs";

const { DAY, PROFILES, buildClock, convertMinor, createCustomerPicker, createRng, invertRate, paymentLedgerState, pickLifecycle, priceOrder, resolveProfile, sampleTime } = shapes;

describe("catalog-scale seed shapes", () => {
  it("keeps the default profile and sizes the huge one", () => {
    expect(PROFILES.default).toMatchObject({ products: 30000, customers: 20000, orders: 50000, huge: false });
    expect(PROFILES.huge).toMatchObject({ products: 50000, customers: 200000, orders: 1000000, huge: true });
    expect(resolveProfile("huge", { orders: 1200 }).orders).toBe(1200);
    expect(() => resolveProfile("nope")).toThrow(/Unknown profile/);
  });

  it("draws the same stream for the same seed", () => {
    const a = createRng(7);
    const b = createRng(7);
    expect(Array.from({ length: 5 }, () => a.rand())).toEqual(Array.from({ length: 5 }, () => b.rand()));
  });

  it("samples order times inside the window, heavier toward the present", () => {
    const rng = createRng(1);
    const end = 1_790_000_000;
    const clock = buildClock(end, 1095);
    const times = Array.from({ length: 6000 }, () => sampleTime(rng, clock));
    expect(Math.min(...times)).toBeGreaterThanOrEqual(end - 1095 * DAY);
    expect(Math.max(...times)).toBeLessThan(end);
    const lastYear = times.filter((time) => time >= end - 365 * DAY).length;
    const firstYear = times.filter((time) => time < end - 730 * DAY).length;
    expect(lastYear).toBeGreaterThan(firstYear);
  });

  it("prices an order so that total = subtotal - discount + tax + shipping, in whole minor units", () => {
    const rng = createRng(3);
    for (let round = 0; round < 500; round += 1) {
      const lines = Array.from({ length: rng.int(1, 6) }, () => ({ unit: rng.int(1, 900000), qty: rng.int(1, 6) }));
      const priced = priceOrder({ lines, shipping: rng.pick([0, 6000, 12000]), discountBps: rng.pick([0, 500, 1500, 2500]), taxBps: rng.pick([0, 500, 2000]) });
      expect(priced.total).toBe(priced.subtotal - priced.discount + priced.tax + priced.shipping);
      expect(priced.subtotal).toBe(priced.lines.reduce((sum: number, line: { subtotal: number }) => sum + line.subtotal, 0));
      expect(priced.discount).toBe(priced.lines.reduce((sum: number, line: { discount: number }) => sum + line.discount, 0));
      expect(priced.tax).toBe(priced.lines.reduce((sum: number, line: { tax: number }) => sum + line.tax, 0));
      for (const line of priced.lines as Array<{ subtotal: number; discount: number; taxable: number }>) {
        expect(Number.isInteger(line.discount)).toBe(true);
        expect(line.discount).toBeLessThan(line.subtotal);
        expect(line.taxable).toBe(line.subtotal - line.discount);
      }
    }
  });

  it("converts at a market rate and inverts it exactly", () => {
    expect(invertRate("0.0082")).toBe("121.951219512195");
    expect(invertRate("0.5")).toBe("2");
    expect(convertMinor(100000, "0.0082")).toBe(820);
    expect(convertMinor(12345, "1")).toBe(12345);
  });

  it("derives the payment ledger state the way refunds do", () => {
    expect(paymentLedgerState({ total: 1000, captured: 1000, refunded: 1000 })).toEqual({ paid: 0, balance: 0, status: "refunded" });
    expect(paymentLedgerState({ total: 1000, captured: 1000, refunded: 250 })).toEqual({ paid: 750, balance: 0, status: "partially_refunded" });
    expect(paymentLedgerState({ total: 1000, captured: 300, refunded: 0 })).toEqual({ paid: 300, balance: 700, status: "partial" });
    expect(paymentLedgerState({ total: 1000, captured: 0, refunded: 0 })).toEqual({ paid: 0, balance: 1000, status: "unpaid" });
    expect(paymentLedgerState({ total: 1000, captured: 1000, refunded: 0 }).status).toBe("paid");
  });

  it("gives every lifecycle a coherent status, payment and fulfilment", () => {
    const rng = createRng(11);
    for (let round = 0; round < 3000; round += 1) {
      const life = pickLifecycle(rng, rng.int(0, 900), rng.chance(0.5));
      if (life.status === "pending" || life.status === "processing" || life.status === "confirmed") expect(life.fulfillment).toBe("pending");
      if (life.delivered) expect(life.fulfillment).toBe("complete");
      if (life.fullReturn) expect(life.fulfillment).toBe("complete");
      if (life.partialReturn) expect(life.payment).toBe("paid");
    }
  });

  it("plans one whale customer with the requested orders and a skewed tail", () => {
    const rng = createRng(5);
    const pick = createCustomerPicker(rng, { customers: 2000, orders: 20000, whaleOrders: 500 });
    const counts = new Map<number, number>();
    for (let order = 0; order < 20000; order += 1) {
      const customer = pick(order);
      expect(customer).toBeGreaterThanOrEqual(0);
      expect(customer).toBeLessThan(2000);
      counts.set(customer, (counts.get(customer) ?? 0) + 1);
    }
    expect(counts.get(0)).toBe(500);
    expect(Math.max(...[...counts.entries()].filter(([customer]) => customer > 0).map(([, count]) => count))).toBeLessThan(500);
  });
});
