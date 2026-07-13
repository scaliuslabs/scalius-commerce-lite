import { describe, expect, it, vi } from "vitest";

const queryOptionMocks = vi.hoisted(() => ({
  checkoutFlowSettingsQueryOptions: vi.fn(() => ({
    queryKey: ["settings", "checkout-flow"],
    queryFn: vi.fn(),
  })),
  paymentMethodsQueryOptions: vi.fn(() => ({
    queryKey: ["settings", "payment-methods"],
    queryFn: vi.fn(),
  })),
  shippingMethodsQueryOptions: vi.fn(() => ({
    queryKey: ["settings", "shipping-methods"],
    queryFn: vi.fn(),
  })),
}));

vi.mock("~/components/admin/settings/CheckoutSettingsPage", () => ({
  default: () => null,
}));

vi.mock("~/lib/api-query-options/settings", () => queryOptionMocks);

vi.mock("~/lib/route-error", () => ({
  RouteErrorComponent: () => null,
}));

import { Route } from "./checkout";

describe("checkout settings route loader", () => {
  it("prefetches only checkout flow without replacing its local retry state", async () => {
    const prefetchQuery = vi.fn(async () => undefined);
    expect(typeof Route.options.loader).toBe("function");

    const loader = Route.options.loader as unknown as (args: {
      context: { queryClient: { prefetchQuery: typeof prefetchQuery } };
    }) => Promise<unknown>;

    await loader({
      context: { queryClient: { prefetchQuery } },
    });

    expect(queryOptionMocks.checkoutFlowSettingsQueryOptions).toHaveBeenCalledOnce();
    expect(queryOptionMocks.paymentMethodsQueryOptions).not.toHaveBeenCalled();
    expect(queryOptionMocks.shippingMethodsQueryOptions).not.toHaveBeenCalled();
    expect(prefetchQuery).toHaveBeenCalledWith({
      queryKey: ["settings", "checkout-flow"],
      queryFn: expect.any(Function),
    });
  });
});
