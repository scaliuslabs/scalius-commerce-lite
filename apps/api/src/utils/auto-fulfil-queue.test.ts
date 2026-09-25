import { afterEach, describe, expect, it, vi } from "vitest";
import { enqueueOrderAutoFulfil } from "./auto-fulfil-queue";

describe("enqueueOrderAutoFulfil", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends exactly the message shape the queue consumer handles", async () => {
    const send = vi.fn(async () => undefined);
    await expect(enqueueOrderAutoFulfil({ send }, "ord_1", "test")).resolves.toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ type: "order.auto_fulfil", orderId: "ord_1" });
  });

  it("never throws into the settle path when the queue is missing or fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(enqueueOrderAutoFulfil(undefined, "ord_1", "test")).resolves.toBe(false);
    await expect(enqueueOrderAutoFulfil({ send: vi.fn() }, "", "test")).resolves.toBe(false);

    const failing = { send: vi.fn(async () => { throw new TypeError("queue down: buyer@example.com"); }) };
    await expect(enqueueOrderAutoFulfil(failing, "ord_2", "test")).resolves.toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    // Only the order id and the error class are logged, never the error text.
    expect(JSON.stringify(warn.mock.calls)).toContain("ord_2");
    expect(JSON.stringify(warn.mock.calls)).toContain("TypeError");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("buyer@example.com");
  });
});
