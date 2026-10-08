// @vitest-environment happy-dom

// Shipping settings say what is true for this store: local pickup is "off"
// while it has no pickup point (not "offered for every address"), and the
// delivery areas of a store outside Bangladesh don't speak of thanas.
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useLocation: ({ select }: { select?: (location: { hash: string }) => unknown } = {}) => (select ? select({ hash: "" }) : { hash: "" }),
  Link: ({ children, to, params: _params, hash: _hash, ...props }: { children: ReactNode; to: string; params?: unknown; hash?: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

vi.mock("@/hooks/use-currency", () => ({
  useCurrency: () => ({ symbol: "৳", code: "BDT", fmt: (value: number) => `৳${value}` }),
}));
vi.mock("~/hooks/use-currency", () => ({
  useCurrency: () => ({ symbol: "৳", code: "BDT", fmt: (value: number) => `৳${value}` }),
}));

import { PermissionProvider } from "~/contexts/PermissionContext";
import { setStoreRegion } from "~/lib/store-time-zone";
import { areaCountsQuery, deliveryZonesQuery } from "~/lib/api-query-options/settings-screens";
import { LocalPickupCard } from "./DeliveryZones";
import { DeliveryAreasCard } from "./ShippingSettings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("shipping settings copy", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    setStoreRegion("BD");
  });

  async function render(node: ReactNode, seed: (client: QueryClient) => void) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    seed(client);
    await act(async () => {
      root.render(<QueryClientProvider client={client}><PermissionProvider isSuperAdmin>{node}</PermissionProvider></QueryClientProvider>);
    });
  }

  const zones = (rates: unknown[]) => ({ zones: [], pickup: { rates } });

  it("says local pickup is off until there is a pickup point", async () => {
    await render(<LocalPickupCard />, (client) => client.setQueryData(deliveryZonesQuery.queryKey, zones([])));
    expect(container.textContent).toContain("Pickup is off until you add a pickup point.");
    expect(container.textContent).not.toContain("offered for every address");
    expect(container.textContent).toContain("No pickup points");
  });

  it("says local pickup is offered everywhere once it has a pickup point", async () => {
    const rate = { id: "r1", name: "Shop", fee: 0, freeOver: null, minOrder: null, maxOrder: null, isActive: true, position: 0 };
    await render(<LocalPickupCard />, (client) => client.setQueryData(deliveryZonesQuery.queryKey, zones([rate])));
    expect(container.textContent).toContain("Pickup is offered for every address.");
    expect(container.textContent).not.toContain("off until");
  });

  it("names thanas only for a store in Bangladesh", async () => {
    setStoreRegion("BD");
    await render(<DeliveryAreasCard />, (client) => client.setQueryData(areaCountsQuery.queryKey, { cities: 3, zones: 12, areas: 40 }));
    expect(container.textContent).toContain("Cities: 3 · Thanas: 12 · Areas: 40");
    act(() => root.unmount());
    root = createRoot(container);
    setStoreRegion("US");
    await render(<DeliveryAreasCard />, (client) => client.setQueryData(areaCountsQuery.queryKey, { cities: 3, zones: 12, areas: 40 }));
    expect(container.textContent).toContain("Cities and areas customers choose from.");
    expect(container.textContent).toContain("Cities: 3 · Areas: 40");
    expect(container.textContent?.toLowerCase()).not.toContain("thana");
  });
});
