// @vitest-environment happy-dom

import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { translate } from "~/i18n";
import { inventoryMessages } from "~/i18n/inventory";
import { resourceMessages } from "~/i18n/resource";

const mocks = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/admin">{children}</a>,
}));
vi.mock("~/lib/api", () => ({ apiData: (call: Promise<unknown>) => call }));
vi.mock("@scalius/api-client/sdk", () => ({ getApiV1AdminInventory: mocks.list }));

import { HistoryTab } from "./HistoryTab";
import { INVENTORY_SEARCH_DEFAULTS, type InventoryFilters } from "./inventory-search";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const movement = (id: string, productName: string, sku: string) => ({
  id, variantId: `var_${id}`, orderId: null, type: "adjusted", quantity: -3, previousStock: 15, newStock: 12,
  notes: "Stocktake: Option matrix edit", createdBy: "admin_1", ledgerVersion: 1, createdAt: 1_790_237_484,
  variantSku: sku, optionLabel: null, productName, actorName: "Local Admin", actorType: "admin",
});

/** The inventory page keeps one session search term for every tab, including History. */
function Page({ initialTerm }: { initialTerm: string }) {
  const [filters, setFilters] = useState<InventoryFilters>({ ...INVENTORY_SEARCH_DEFAULTS, section: "movements", q: initialTerm });
  return <HistoryTab filters={filters} onFiltersChange={(patch) => setFilters((current) => ({ ...current, ...patch }))} />;
}

describe("inventory history search", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mocks.list.mockImplementation(async ({ query }: { query: { search?: string } }) => ({
      movements: query.search
        ? [movement("m1", "Simple saree", "SAREE")]
        : [movement("m2", "Cotton panjabi", "PANJABI-S-WHITE"), movement("m1", "Simple saree", "SAREE")],
      pageInfo: { limit: 50, hasMore: false, nextCursor: null },
    }));
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.clearAllMocks();
  });

  const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

  it("shows a carried-over search term and clearing it brings back every change", async () => {
    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <Page initialTerm="SAREE" />
        </QueryClientProvider>,
      );
    });
    await settle();

    const search = host.querySelector<HTMLInputElement>(`input[aria-label="${translate(inventoryMessages, "searchProducts")}"]`)!;
    expect(search.value).toBe("SAREE");
    expect(mocks.list).toHaveBeenLastCalledWith({ query: expect.objectContaining({ section: "movements", search: "SAREE" }) });
    expect(host.textContent).not.toContain("Cotton panjabi");

    const clear = host.querySelector<HTMLButtonElement>(`button[aria-label="${translate(resourceMessages, "clearSearch")}"]`)!;
    await act(async () => clear.click());
    await settle();

    expect(search.value).toBe("");
    expect(mocks.list).toHaveBeenLastCalledWith({ query: expect.objectContaining({ search: undefined }) });
    expect(host.textContent).toContain("Cotton panjabi");
  });
});
