// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { translate } from "~/i18n";
import { inventoryMessages } from "~/i18n/inventory";

const mocks = vi.hoisted(() => ({ valuation: vi.fn() }));
vi.mock("@scalius/api-client/sdk", () => ({ getApiV1AdminInventoryValuation: mocks.valuation }));
vi.mock("~/lib/api", () => ({ apiData: (call: unknown) => call }));
vi.mock("~/hooks/use-currency", () => ({
  useCurrency: () => ({ symbol: "৳", code: "BDT", fmt: (amount: number) => `৳${amount}`, salePrice: () => null }),
}));

import { ValuationSummary } from "./ValuationSummary";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const t = (key: keyof typeof inventoryMessages.en, vars?: Record<string, string | number>) => translate(inventoryMessages, key, vars);

const location = (locationId: string, name: string, units: number, value: number, extra: Partial<{ status: "active" | "archived"; skusWithoutCost: number }> = {}) => ({
  locationId, name, code: locationId, isDefault: locationId === "loc_main", status: extra.status ?? "active",
  units, value, unitsWithoutCost: 0, skusWithoutCost: extra.skusWithoutCost ?? 0,
});

describe("ValuationSummary", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.clearAllMocks();
  });

  async function render() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => root.render(<QueryClientProvider client={client}><ValuationSummary /></QueryClientProvider>));
    await vi.waitFor(() => expect(host.textContent).not.toContain("…"));
  }

  it("shows just the total with one location", async () => {
    mocks.valuation.mockResolvedValue({
      currencyCode: "BDT",
      locations: [location("loc_main", "Main location", 120, 54000)],
      total: { units: 120, value: 54000, unitsWithoutCost: 0, skusWithoutCost: 0 },
      inTransit: { units: 0, value: 0, unitsWithoutCost: 0 },
    });
    await render();
    await vi.waitFor(() => expect(host.textContent).toContain("৳54000"));
    expect(host.textContent).toContain(t("valueUnits", { count: 120 }));
    expect(host.querySelector("dl")).toBeNull();
    expect(host.textContent).not.toContain("Main location");
    expect(host.textContent).not.toContain(t("inTransitValue", { count: 0, value: "৳0" }));
  });

  it("breaks the value down by location, with units in transit and SKUs without a cost", async () => {
    mocks.valuation.mockResolvedValue({
      currencyCode: "BDT",
      locations: [
        location("loc_main", "Main location", 100, 40000, { skusWithoutCost: 2 }),
        location("loc_banani", "Banani store", 20, 9000.5),
        location("loc_old", "Old depot", 3, 0, { status: "archived", skusWithoutCost: 1 }),
      ],
      total: { units: 123, value: 49000.5, unitsWithoutCost: 7, skusWithoutCost: 3 },
      inTransit: { units: 6, value: 2400, unitsWithoutCost: 0 },
    });
    await render();
    await vi.waitFor(() => expect(host.textContent).toContain("৳49000.5"));
    const rows = Array.from(host.querySelectorAll("dl > div")).map((row) => row.textContent);
    expect(rows).toEqual([
      `Main location${t("valueLocationUnits", { count: 100 })} · ৳40000`,
      `Banani store${t("valueLocationUnits", { count: 20 })} · ৳9000.5`,
      `${t("locationArchived", { name: "Old depot" })}${t("valueLocationUnits", { count: 3 })} · ৳0`,
    ]);
    expect(host.textContent).toContain(t("inTransitValue", { count: 6, value: "৳2400" }));
    expect(host.textContent).toContain(t("valueMissingCost", { count: 3 }));
  });

  it("says when one SKU has no cost", async () => {
    mocks.valuation.mockResolvedValue({
      currencyCode: "BDT",
      locations: [location("loc_main", "Main location", 10, 0, { skusWithoutCost: 1 })],
      total: { units: 10, value: 0, unitsWithoutCost: 10, skusWithoutCost: 1 },
      inTransit: { units: 0, value: 0, unitsWithoutCost: 0 },
    });
    await render();
    await vi.waitFor(() => expect(host.textContent).toContain(t("valueMissingCostOne")));
  });

  it("says when the value couldn't load", async () => {
    mocks.valuation.mockRejectedValue(new Error("offline"));
    await render();
    await vi.waitFor(() => expect(host.textContent).toContain(t("valueFailed")));
  });
});
