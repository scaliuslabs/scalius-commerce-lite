import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInvalidator, keysForChanges, resyncKeys } from "./invalidate";

describe("realtime invalidation", () => {
  let client: QueryClient;
  const states = () => Object.fromEntries(client.getQueryCache().getAll().map((query) => [JSON.stringify(query.queryKey), query.state.isInvalidated]));

  beforeEach(() => {
    vi.useFakeTimers();
    client = new QueryClient();
    for (const key of [
      ["orders", "list", { page: 1 }],
      ["orders", "detail", "ord_1"],
      ["orders", "payments", "ord_1"],
      ["orders", "detail", "ord_2"],
      ["dashboard", "summary"],
      ["conversations", "thread", "cnv_1"],
      ["reviews", "summary", null],
      ["products", "detail", "prd_1"],
    ]) client.setQueryData(key, { ok: true });
  });

  afterEach(() => {
    client.clear();
    vi.useRealTimers();
  });

  it("marks only the changed order's reads and the home page, once per burst", async () => {
    const spy = vi.spyOn(client, "invalidateQueries");
    const invalidator = createInvalidator(client, 250);
    invalidator.add(keysForChanges([{ topic: "orders", kind: "order.updated", id: "ord_1", status: "confirmed" }]));
    invalidator.add(keysForChanges([{ topic: "payments", kind: "order.paid", id: "ord_1" }]));
    await vi.advanceTimersByTimeAsync(250);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(states()).toMatchObject({
      '["orders","list",{"page":1}]': false,
      '["orders","detail","ord_1"]': true,
      '["orders","payments","ord_1"]': true,
      '["orders","detail","ord_2"]': false,
      '["dashboard","summary"]': true,
    });
  });

  it("never touches the order list for a new order (the list offers it)", async () => {
    const invalidator = createInvalidator(client, 0);
    invalidator.add(keysForChanges([{ topic: "orders", kind: "order.created", id: "ord_9" }]));
    await vi.advanceTimersByTimeAsync(0);
    expect(states()['["orders","list",{"page":1}]']).toBe(false);
  });

  it("refreshes the inbox and reviews on table notices, and everything heard on resync", async () => {
    const invalidator = createInvalidator(client, 0);
    invalidator.add(keysForChanges([{ topic: "inbox", kind: "changed" }, { topic: "reviews", kind: "changed" }]));
    await vi.advanceTimersByTimeAsync(0);
    expect(states()).toMatchObject({ '["conversations","thread","cnv_1"]': true, '["reviews","summary",null]': true, '["products","detail","prd_1"]': false });
    invalidator.add(resyncKeys(["products"]));
    await vi.advanceTimersByTimeAsync(0);
    expect(states()['["products","detail","prd_1"]']).toBe(true);
  });
});
