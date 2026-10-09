// @vitest-environment happy-dom

import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { translate } from "~/i18n";
import { inventoryMessages } from "~/i18n/inventory";
import { resourceMessages } from "~/i18n/resource";

const mocks = vi.hoisted(() => ({ list: vi.fn(), locations: vi.fn() }));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/admin">{children}</a>,
  useNavigate: () => () => undefined,
}));
vi.mock("~/lib/api", () => ({ apiData: (call: Promise<unknown>) => call }));
vi.mock("@scalius/api-client/sdk", () => ({
  getApiV1AdminInventory: mocks.list,
  getApiV1AdminInventoryLocations: mocks.locations,
}));

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
    mocks.locations.mockResolvedValue({ locations: [] });
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

  it("names purchase order receipts and transfers and filters by them", async () => {
    mocks.list.mockImplementation(async () => ({
      movements: [
        { ...movement("m4", "Cotton panjabi", "PANJABI-M"), type: "received", notes: "Received on purchase order PO1001" },
        { ...movement("m5", "Cotton panjabi", "PANJABI-M"), type: "transfer_out", notes: "Shipped on transfer T1001" },
        { ...movement("m6", "Cotton panjabi", "PANJABI-M"), type: "transfer_in", notes: "Returned to origin: transfer T1002 cancelled" },
      ],
      pageInfo: { limit: 50, hasMore: false, nextCursor: null },
    }));
    function ReceivedPage() {
      const [filters, setFilters] = useState<InventoryFilters>({ ...INVENTORY_SEARCH_DEFAULTS, section: "movements", q: "", type: "received" });
      return <HistoryTab filters={filters} onFiltersChange={(patch) => setFilters((current) => ({ ...current, ...patch }))} />;
    }
    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <ReceivedPage />
        </QueryClientProvider>,
      );
    });
    await settle();

    expect(mocks.list).toHaveBeenLastCalledWith({ query: expect.objectContaining({ movementType: "received" }) });
    const text = host.textContent ?? "";
    expect(text).toContain(translate(inventoryMessages, "type_received"));
    expect(text).toContain(translate(inventoryMessages, "type_transfer_out"));
    expect(text).toContain(translate(inventoryMessages, "type_transfer_in"));
    expect(text).toContain(translate(inventoryMessages, "notePurchaseOrder", { number: "PO1001" }));
    expect(text).toContain(translate(inventoryMessages, "noteTransfer", { number: "T1001" }));
    expect(text).toContain(translate(inventoryMessages, "sourceTransferCancelled"));
    // Server sentences never show as if a person typed them.
    expect(text).not.toContain("Received on purchase order");
  });

  it("filters by location and names where stock moved once a store has several", async () => {
    const location = (id: string, name: string, isDefault: boolean, status = "active") => ({ id, name, isDefault, status });
    mocks.locations.mockResolvedValue({
      locations: [location("loc_default", "Main location", true), location("loc_branch", "Banani store", false), location("loc_old", "Old depot", false, "archived")],
    });
    mocks.list.mockImplementation(async () => ({
      movements: [
        // An adjustment recorded the branch's own count: 5 → 2 there, 15 → 12 in all.
        {
          ...movement("m3", "Simple saree", "SAREE"), ledgerVersion: 2, stockDelta: -3, locationId: "loc_branch", locationName: "Banani store",
          locationPreviousStock: 5, locationNewStock: 2,
        },
        // A transfer in names the location; only the store total has a before and after.
        {
          ...movement("m4", "Cotton panjabi", "PANJABI"), type: "transfer_in", notes: "Received on transfer T1001", ledgerVersion: 2,
          stockDelta: 4, previousStock: 8, newStock: 12, locationId: "loc_branch", locationName: "Banani store",
          locationPreviousStock: null, locationNewStock: null,
        },
      ],
      pageInfo: { limit: 50, hasMore: false, nextCursor: null },
    }));
    function LocationPage() {
      const [filters, setFilters] = useState<InventoryFilters>({ ...INVENTORY_SEARCH_DEFAULTS, section: "movements", q: "", location: "loc_branch" });
      return <HistoryTab filters={filters} onFiltersChange={(patch) => setFilters((current) => ({ ...current, ...patch }))} />;
    }
    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <LocationPage />
        </QueryClientProvider>,
      );
    });
    await settle();

    expect(mocks.list).toHaveBeenLastCalledWith({ query: expect.objectContaining({ movementLocationId: "loc_branch" }) });
    const at = translate(inventoryMessages, "onHandAtLocation", { location: "Banani store" });
    const all = translate(inventoryMessages, "onHandAllLocations");
    // The change cell shows the main change; its title names every count it moved.
    const titles = [...host.querySelectorAll("[title]")]
      .map((node) => node.getAttribute("title"))
      .filter((title) => title?.startsWith(at));
    expect(titles).toEqual([
      `${at} -3 5 → 2\n${all} 15 → 12`,
      `${at} +4\n${all} 8 → 12`,
    ]);
    // The location filter is set: the Filters button counts it.
    expect([...host.querySelectorAll("button")].some((node) => node.textContent?.includes("(1)"))).toBe(true);
  });

  it("says how many licence keys were imported, never the key pool's id", async () => {
    mocks.list.mockImplementation(async () => ({
      movements: [
        { ...movement("m5", "Office suite", "OFFICE-KEY"), notes: "Licence keys (Imported): 3 keys into dga_AbC123xyz0000000", ledgerVersion: 2, stockDelta: 3 },
        { ...movement("m6", "Office suite", "OFFICE-KEY"), notes: "Licence keys (Imported)", ledgerVersion: 2, stockDelta: 1 },
      ],
      pageInfo: { limit: 50, hasMore: false, nextCursor: null },
    }));
    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <Page initialTerm="" />
        </QueryClientProvider>,
      );
    });
    await settle();
    const text = host.textContent ?? "";
    expect(text).toContain(translate(inventoryMessages, "noteKeysImported", { count: 3 }));
    expect(text).toContain(translate(inventoryMessages, "noteKeyImported"));
    expect(text).toContain("Office suite");
    expect(text).not.toContain("dga_");
    expect(text).not.toContain("Licence keys (");
  });
});
