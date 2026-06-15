import { describe, expect, it, vi } from "vitest";

const queryOptionMocks = vi.hoisted(() => ({
  authSettingsQueryOptions: vi.fn(() => ({
    queryKey: ["settings", "auth"],
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
  it("preloads only the default checkout-flow auth settings", async () => {
    const ensureQueryData = vi.fn(async () => undefined);
    expect(typeof Route.options.loader).toBe("function");

    const loader = Route.options.loader as unknown as (args: {
      context: { queryClient: { ensureQueryData: typeof ensureQueryData } };
    }) => Promise<unknown>;

    await loader({
      context: { queryClient: { ensureQueryData } },
    });

    expect(queryOptionMocks.authSettingsQueryOptions).toHaveBeenCalledOnce();
    expect(queryOptionMocks.paymentMethodsQueryOptions).not.toHaveBeenCalled();
    expect(queryOptionMocks.shippingMethodsQueryOptions).not.toHaveBeenCalled();
    expect(ensureQueryData).toHaveBeenCalledWith({
      queryKey: ["settings", "auth"],
      queryFn: expect.any(Function),
    });
  });
});
