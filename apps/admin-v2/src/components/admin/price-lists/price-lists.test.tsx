// @vitest-environment happy-dom
/**
 * Products › Price lists (docs/MARKETS-DESIGN.md D5): the list, and one
 * list's page saving its details and its SKU prices under its revision.
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  getApiV1AdminPriceLists: vi.fn(),
  getApiV1AdminPriceListsById: vi.fn(),
  getApiV1AdminPriceListsByIdPrices: vi.fn(),
  getApiV1AdminPriceListsChoices: vi.fn(),
  patchApiV1AdminPriceListsById: vi.fn(),
  postApiV1AdminPriceLists: vi.fn(),
  putApiV1AdminPriceListsByIdPrices: vi.fn(),
  deleteApiV1AdminPriceListsById: vi.fn(),
}));
vi.mock("@scalius/api-client/sdk", () => sdk);
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@tanstack/react-router", () => ({
  useBlocker: () => ({ status: "idle" }),
  useNavigate: () => vi.fn(),
  useLocation: ({ select }: { select?: (location: { hash: string }) => unknown } = {}) => (select ? select({ hash: "" }) : { hash: "" }),
  Link: ({ children, to, params: _params, ...props }: { children: ReactNode; to: string; params?: unknown }) => <a href={to} {...props}>{children}</a>,
}));

import { PermissionProvider } from "~/contexts/PermissionContext";
import { CreatePriceListDialog } from "./CreatePriceListDialog";
import { PriceListEditor } from "./PriceListEditor";
import { PriceListsList } from "./PriceListsList";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const envelope = <T,>(data: T) => Promise.resolve({ data: { success: true, data } });
const sale = {
  id: "pl_sale", name: "Eid sale", description: null, kind: "sale" as const, marketId: "mkt_in", marketName: "India", marketIsBackup: false,
  segmentId: null, segmentName: null, status: "active" as const, state: "scheduled" as const,
  startsAt: "2026-11-01T00:00:00.000Z", endsAt: null, priority: 0, revision: 2, priceCount: 3, variantCount: 2,
  currencyCode: "BDT", priceIncrement: 1, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
};
const trade = { ...sale, id: "pl_trade", name: "Trade", kind: "segment" as const, marketId: "mkt_backup", marketName: "Bangladesh", marketIsBackup: true, segmentId: "seg_1", segmentName: "Wholesale", state: "active" as const, startsAt: null };
const tee = {
  variantId: "var_tee", productId: "prod_tee", productName: "Tee", variantLabel: "M", sku: "TEE-M", basePrice: 500,
  prices: [{ currencyCode: "BDT", amount: 450, compareAt: null, minQuantity: 1 }, { currencyCode: "BDT", amount: 400, compareAt: null, minQuantity: 10 }],
};

describe("price lists", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.clearAllMocks();
    notifyManager.setNotifyFunction((callback) => { act(callback); });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    sdk.getApiV1AdminPriceLists.mockImplementation(() => envelope({ items: [sale, trade] }));
    sdk.getApiV1AdminPriceListsById.mockImplementation(() => envelope({ priceList: sale }));
    sdk.getApiV1AdminPriceListsByIdPrices.mockImplementation(() => envelope({ items: [tee], total: 1, page: 1, limit: 25 }));
    sdk.patchApiV1AdminPriceListsById.mockImplementation(({ body }: { body: Record<string, unknown> }) => {
      const { expectedRevision: _revision, ...changes } = body;
      return envelope({ priceList: { ...sale, ...changes, revision: sale.revision + 1 } });
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
    notifyManager.setNotifyFunction((callback) => callback());
  });

  async function render(children: ReactNode) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <PermissionProvider isSuperAdmin>{children}</PermissionProvider>
        </QueryClientProvider>,
      );
    });
  }

  it("lists each price list with its state, type, market and SKU count", async () => {
    await render(<PriceListsList />);
    await vi.waitFor(() => expect(container.querySelectorAll("tbody tr")).toHaveLength(2));
    const [first, second] = [...container.querySelectorAll("tbody tr")].map((row) => row.textContent);
    expect(first).toContain("Eid sale");
    expect(first).toContain("Scheduled");
    expect(first).toContain("Sale");
    expect(first).toContain("India");
    expect(first).toContain("From ");
    expect(second).toContain("Wholesale in Bangladesh");
    expect(second).toContain("Always");
  });

  it("offers a one-market store only a customer segment list, and asks for no market", async () => {
    sdk.getApiV1AdminPriceListsChoices.mockImplementation(() => envelope({
      markets: [{ id: "mkt_backup", name: "Bangladesh", isBackup: true, currencyCode: "BDT" }],
      segments: [{ id: "seg_1", name: "Wholesale" }],
    }));
    await render(<CreatePriceListDialog open onOpenChange={() => undefined} />);
    await vi.waitFor(() => expect(document.body.textContent).toContain("Customer segment"));
    const radios = [...document.body.querySelectorAll<HTMLButtonElement>("button[role=radio]")];
    expect(radios.map((radio) => radio.disabled)).toEqual([true, false, true]);
    expect(radios[1]!.getAttribute("aria-checked")).toBe("true");
    expect(document.body.textContent).toContain("Add a second market in Settings › Markets first.");
    expect(document.body.querySelector("#price-list-create-market")).toBeNull();
    expect(document.body.querySelector("#price-list-create-segment")).not.toBeNull();
  });

  it("shows a list's SKU prices and saves its details under the revision it loaded", async () => {
    await render(<PriceListEditor priceList={sale} />);
    await vi.waitFor(() => expect(container.textContent).toContain("TEE-M"));
    expect(container.textContent).toContain("10+ units");
    const name = container.querySelector<HTMLInputElement>("#price-list-name")!;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      set.call(name, "Eid sale 2026");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // The page owns its save bar: its Save button saves.
    const save = [...container.querySelectorAll("button")].find((button) => button.textContent === "Save")!;
    await act(async () => { save.click(); });
    await vi.waitFor(() => expect(sdk.patchApiV1AdminPriceListsById).toHaveBeenCalled());
    expect(sdk.patchApiV1AdminPriceListsById.mock.calls[0]![0]).toMatchObject({
      path: { id: "pl_sale" },
      body: { expectedRevision: 2, name: "Eid sale 2026", status: "active", priority: 0, startsAt: "2026-11-01T00:00:00.000Z", endsAt: null },
    });
  });
});
