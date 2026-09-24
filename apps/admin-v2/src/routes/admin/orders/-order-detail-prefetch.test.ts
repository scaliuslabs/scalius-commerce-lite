import { afterEach, describe, expect, it, vi } from "vitest";

const queryOptionMocks = vi.hoisted(() => ({
  orderQueryOptions: vi.fn((id: string) => ({
    queryKey: ["orders", "detail", id],
    queryFn: vi.fn(),
  })),
  orderShipmentsQueryOptions: vi.fn((id: string) => ({
    queryKey: ["orders", "shipments", id],
    queryFn: vi.fn(),
  })),
  orderPaymentsQueryOptions: vi.fn((id: string) => ({
    queryKey: ["orders", "payments", id],
    queryFn: vi.fn(),
  })),
  orderCodQueryOptions: vi.fn((id: string) => ({
    queryKey: ["orders", "cod", id],
    queryFn: vi.fn(),
  })),
  orderReturnsQueryOptions: vi.fn((id: string) => ({
    queryKey: ["orders", "returns", id],
    queryFn: vi.fn(),
  })),
  orderNotificationsQueryOptions: vi.fn((id: string) => ({
    queryKey: ["orders", "notifications", id],
    queryFn: vi.fn(),
  })),
  orderTimelineQueryOptions: vi.fn((id: string) => ({
    queryKey: ["orders", "timeline", id],
    queryFn: vi.fn(),
  })),
  deliveryProvidersQueryOptions: vi.fn(() => ({
    queryKey: ["settings", "delivery-providers"],
    queryFn: vi.fn(),
  })),
  currencySettingsQueryOptions: vi.fn(() => ({
    queryKey: ["settings", "currency"],
    queryFn: vi.fn(),
  })),
}));

vi.mock("../../../lib/api-query-options/orders", () => ({
  orderCodQueryOptions: queryOptionMocks.orderCodQueryOptions,
  orderNotificationsQueryOptions: queryOptionMocks.orderNotificationsQueryOptions,
  orderReturnsQueryOptions: queryOptionMocks.orderReturnsQueryOptions,
  orderTimelineQueryOptions: queryOptionMocks.orderTimelineQueryOptions,
  orderPaymentsQueryOptions: queryOptionMocks.orderPaymentsQueryOptions,
  orderQueryOptions: queryOptionMocks.orderQueryOptions,
  orderShipmentsQueryOptions: queryOptionMocks.orderShipmentsQueryOptions,
}));

vi.mock("../../../lib/api-query-options/delivery", () => ({
  deliveryProvidersQueryOptions:
    queryOptionMocks.deliveryProvidersQueryOptions,
}));

vi.mock("../../../lib/api-query-options/currency", () => ({
  currencySettingsQueryOptions: queryOptionMocks.currencySettingsQueryOptions,
}));

import { prefetchOrderDetailQueries } from "../../../lib/order-detail-prefetch";

type PrefetchClient = Parameters<typeof prefetchOrderDetailQueries>[0];

function createQueryClient(
  paymentMethod: string | null,
  options?: {
    hangPayments?: boolean;
    rejectOrder?: boolean;
    rejectPayments?: boolean;
    rejectProviders?: boolean;
    rejectShipments?: boolean;
  },
) {
  const ensureQueryData = vi.fn(async (queryOptions: { queryKey: readonly unknown[] }) => {
    if (queryOptions.queryKey[0] === "orders" && queryOptions.queryKey[1] === "detail") {
      if (options?.rejectOrder) {
        throw new Error("order detail temporarily unavailable");
      }
      return { id: "ord_1", paymentMethod };
    }
    return [];
  });
  const prefetchQuery = vi.fn(async (queryOptions: { queryKey: readonly unknown[] }) => {
    if (options?.hangPayments && queryOptions.queryKey[1] === "payments") {
      await new Promise(() => {});
    }
    if (options?.rejectShipments && queryOptions.queryKey[1] === "shipments") {
      throw new Error("shipments temporarily unavailable");
    }
    if (options?.rejectPayments && queryOptions.queryKey[1] === "payments") {
      throw new Error("payment history temporarily unavailable");
    }
    if (
      options?.rejectProviders &&
      queryOptions.queryKey[0] === "settings" &&
      queryOptions.queryKey[1] === "delivery-providers"
    ) {
      throw new Error("delivery providers temporarily unavailable");
    }
  });

  return {
    queryClient: { ensureQueryData, prefetchQuery } as unknown as PrefetchClient,
    ensureQueryData,
    prefetchQuery,
  };
}

describe("order detail prefetch", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("requires order detail and warms every card read, plus COD tracking for COD orders", async () => {
    const { queryClient, ensureQueryData, prefetchQuery } = createQueryClient("cod");

    await prefetchOrderDetailQueries(queryClient, "ord_1", { couriers: true });

    expect(ensureQueryData.mock.calls.map(([options]) => options.queryKey)).toEqual([
      ["orders", "detail", "ord_1"],
    ]);
    expect(prefetchQuery.mock.calls.map(([options]) => options.queryKey)).toEqual(
      expect.arrayContaining([
        ["orders", "shipments", "ord_1"],
        ["orders", "payments", "ord_1"],
        ["orders", "returns", "ord_1"],
        ["orders", "notifications", "ord_1"],
        ["orders", "timeline", "ord_1"],
        ["orders", "cod", "ord_1"],
        ["settings", "currency"],
        ["settings", "delivery-providers"],
      ]),
    );
  });

  it("skips the courier list for staff who can't book couriers", async () => {
    const { queryClient, prefetchQuery } = createQueryClient("cod");

    await prefetchOrderDetailQueries(queryClient, "ord_1", { couriers: false });

    expect(prefetchQuery.mock.calls.map(([options]) => options.queryKey))
      .not.toContainEqual(["settings", "delivery-providers"]);
  });

  it("does not request COD tracking for non-COD orders", async () => {
    const { queryClient, prefetchQuery } = createQueryClient("stripe");

    await prefetchOrderDetailQueries(queryClient, "ord_1", { couriers: true });

    const prefetchedKeys = prefetchQuery.mock.calls.map(([options]) => options.queryKey);
    expect(prefetchedKeys).toEqual(
      expect.arrayContaining([
        ["orders", "payments", "ord_1"],
        ["settings", "currency"],
        ["settings", "delivery-providers"],
      ]),
    );
    expect(prefetchedKeys).not.toContainEqual(["orders", "cod", "ord_1"]);
  });

  it("keeps the order page loadable when optional payment prefetch fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { queryClient } = createQueryClient("stripe", { rejectPayments: true });

    await expect(prefetchOrderDetailQueries(queryClient, "ord_1", { couriers: true })).resolves.toMatchObject({ id: "ord_1" });
    await Promise.resolve();
    expect(warn).toHaveBeenCalledWith("Order detail warm query skipped", expect.any(Error));
  });

  it("rejects when the required order detail read fails so the route can show retry UI", async () => {
    const { queryClient, prefetchQuery } = createQueryClient("stripe", {
      rejectOrder: true,
    });

    await expect(prefetchOrderDetailQueries(queryClient, "ord_1", { couriers: true })).rejects.toThrow(
      "order detail temporarily unavailable",
    );
    expect(prefetchQuery.mock.calls.map(([options]) => options.queryKey)).not.toContainEqual(["orders", "cod", "ord_1"]);
  });

  it("starts the card reads in the same round trip as the order, not after it", async () => {
    let resolveOrder: (value: { id: string; paymentMethod: string | null }) => void = () => {};
    const { queryClient, ensureQueryData, prefetchQuery } = createQueryClient("stripe");
    ensureQueryData.mockImplementationOnce(() => new Promise<{ id: string; paymentMethod: string | null }>((resolve) => { resolveOrder = resolve; }));

    const pending = prefetchOrderDetailQueries(queryClient, "ord_1", { couriers: false });
    expect(prefetchQuery.mock.calls.map(([options]) => options.queryKey)).toEqual(
      expect.arrayContaining([
        ["orders", "shipments", "ord_1"],
        ["orders", "payments", "ord_1"],
        ["orders", "returns", "ord_1"],
        ["orders", "notifications", "ord_1"],
        ["orders", "timeline", "ord_1"],
      ]),
    );
    resolveOrder({ id: "ord_1", paymentMethod: "stripe" });
    await expect(pending).resolves.toMatchObject({ id: "ord_1" });
  });

  it("keeps the order page loadable when delivery provider prefetch fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { queryClient } = createQueryClient("stripe", { rejectProviders: true });

    await expect(prefetchOrderDetailQueries(queryClient, "ord_1", { couriers: true })).resolves.toMatchObject({ id: "ord_1" });
    await Promise.resolve();
    expect(warn).toHaveBeenCalledWith("Order detail warm query skipped", expect.any(Error));
  });

  it("keeps the order page loadable when shipment prefetch fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { queryClient } = createQueryClient("stripe", { rejectShipments: true });

    await expect(prefetchOrderDetailQueries(queryClient, "ord_1", { couriers: true })).resolves.toMatchObject({ id: "ord_1" });
    await Promise.resolve();
    expect(warn).toHaveBeenCalledWith("Order detail warm query skipped", expect.any(Error));
  });

  it("does not wait for optional warm queries before letting the route render", async () => {
    const { queryClient } = createQueryClient("stripe", { hangPayments: true });

    await expect(prefetchOrderDetailQueries(queryClient, "ord_1", { couriers: true })).resolves.toMatchObject({ id: "ord_1" });
  });
});
