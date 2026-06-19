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
    rejectPayments?: boolean;
    rejectProviders?: boolean;
    rejectShipments?: boolean;
  },
) {
  const ensureQueryData = vi.fn(async (queryOptions: { queryKey: readonly unknown[] }) => {
    if (queryOptions.queryKey[0] === "orders" && queryOptions.queryKey[1] === "detail") {
      return { id: "ord_1", paymentMethod };
    }
    return [];
  });
  const prefetchQuery = vi.fn(async (queryOptions: { queryKey: readonly unknown[] }) => {
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

  it("requires order detail and warms shipments, providers, payments, and COD tracking for COD orders", async () => {
    const { queryClient, ensureQueryData, prefetchQuery } = createQueryClient("cod");

    await prefetchOrderDetailQueries(queryClient, "ord_1");

    expect(ensureQueryData.mock.calls.map(([options]) => options.queryKey)).toEqual([
      ["orders", "detail", "ord_1"],
    ]);
    expect(prefetchQuery.mock.calls.map(([options]) => options.queryKey)).toEqual(
      expect.arrayContaining([
        ["orders", "shipments", "ord_1"],
        ["orders", "payments", "ord_1"],
        ["orders", "cod", "ord_1"],
        ["settings", "currency"],
        ["settings", "delivery-providers"],
      ]),
    );
  });

  it("does not request COD tracking for non-COD orders", async () => {
    const { queryClient, prefetchQuery } = createQueryClient("stripe");

    await prefetchOrderDetailQueries(queryClient, "ord_1");

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

    await expect(prefetchOrderDetailQueries(queryClient, "ord_1")).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith("Order payment prefetch skipped", expect.any(Error));
  });

  it("keeps the order page loadable when delivery provider prefetch fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { queryClient } = createQueryClient("stripe", { rejectProviders: true });

    await expect(prefetchOrderDetailQueries(queryClient, "ord_1")).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith("Order delivery provider prefetch skipped", expect.any(Error));
  });

  it("keeps the order page loadable when shipment prefetch fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { queryClient } = createQueryClient("stripe", { rejectShipments: true });

    await expect(prefetchOrderDetailQueries(queryClient, "ord_1")).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith("Order shipment prefetch skipped", expect.any(Error));
  });
});
