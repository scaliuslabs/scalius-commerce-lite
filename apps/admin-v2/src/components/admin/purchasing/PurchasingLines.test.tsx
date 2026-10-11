// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { translate } from "~/i18n";
import { purchasingMessages } from "~/i18n/purchasing";
import { resourceMessages } from "~/i18n/resource";
import type { PurchaseOrder, Transfer } from "~/lib/api-query-options/purchasing";
import type { InventoryVariant } from "~/lib/api-query-options/inventory";

const mocks = vi.hoisted(() => ({ mobile: false, saveOrder: vi.fn(), saveTransfer: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/admin">{children}</a>,
  useNavigate: () => vi.fn(),
  useBlocker: () => ({ proceed: vi.fn(), reset: vi.fn(), status: "idle" }),
}));
vi.mock("~/hooks/use-mobile", () => ({ useIsMobile: () => mocks.mobile }));
vi.mock("~/hooks/use-catalog-action-permissions", () => ({
  useCatalogActionPermissions: () => ({ inventory: {
    canManageOperations: true, canDraftPurchaseOrders: true, canViewCosts: true,
  } }),
}));
vi.mock("~/hooks/use-currency", () => ({
  useCurrency: () => ({ symbol: "৳", code: "BDT", fmt: (amount: number) => `৳${amount.toFixed(2)}` }),
}));
vi.mock("~/components/admin/layout/store-identity", () => ({ useStoreIdentity: () => ({ name: "Kori", host: "" }) }));
vi.mock("~/lib/api", () => ({ apiData: (call: Promise<unknown>) => call }));
vi.mock("./SkuPicker", () => ({
  SkuPicker: ({ onPick, disabled, addedIds }: {
    onPick: (variant: InventoryVariant) => void; disabled?: boolean; addedIds: ReadonlySet<string>;
  }) => <button type="button" aria-label="Add fixture SKU" disabled={disabled} data-added-count={addedIds.size}
    onClick={() => onPick({
      id: "var_101", productId: "prod_101", productName: "New product", optionLabel: null, sku: "SKU0101", cost: 5,
    } as InventoryVariant)}>Add fixture SKU</button>,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@scalius/api-client/sdk", () => ({
  getApiV1AdminInventoryLocations: async () => ({ locations: [
    { id: "loc_1", name: "Gulshan", code: "GUL", status: "active", isDefault: true },
    { id: "loc_2", name: "Mirpur", code: "MIR", status: "active", isDefault: false },
  ] }),
  putApiV1AdminInventoryPurchaseOrdersByPurchaseOrderId: mocks.saveOrder,
  putApiV1AdminInventoryTransfersByTransferId: mocks.saveTransfer,
}));

import { PurchaseOrderDetail } from "./PurchaseOrderDetail";
import { PurchaseOrderEditor } from "./PurchaseOrderEditor";
import { TransferDetail } from "./TransferDetail";
import { TransferEditor } from "./TransferEditor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const t = (key: keyof typeof purchasingMessages.en, vars?: Record<string, string | number>) => translate(purchasingMessages, key, vars);
const r = (key: keyof typeof resourceMessages.en) => translate(resourceMessages, key);
const lines = Array.from({ length: 100 }, (_, index) => ({
  id: `line_${index + 1}`, variantId: `var_${index + 1}`, productId: `prod_${index + 1}`,
  productName: `Product ${index + 1}`, optionLabel: index === 98 ? "Indigo special" : null,
  sku: `SKU${String(index + 1).padStart(4, "0")}`, barcode: `barcode-${index + 1}`,
  retired: false, position: index, quantity: 1, receivedQuantity: 0, openQuantity: 1,
  unitCost: 10, currentCost: 10, lineTotal: 10, shippedQuantity: 1, inTransitQuantity: 1, returnedQuantity: 0,
}));
const order = {
  id: "po_1", number: 1001, displayNumber: "PO1001", status: "ordered", revision: 3, currencyCode: "BDT",
  supplier: null, destination: { id: "loc_1", name: "Gulshan", code: "GUL", status: "active" },
  expectedOn: null, reference: null, notes: null, shipping: 0, otherCosts: 0, tax: 0,
  lineCount: 100, quantity: 100, receivedQuantity: 0, subtotal: 1000, total: 1000,
  orderedAt: 1700000000, receivedAt: null, cancelledAt: null, createdAt: 1700000000, updatedAt: 1700000000,
  lines, receipts: [],
} as unknown as PurchaseOrder;
const transfer = {
  id: "tr_1", number: 1001, displayNumber: "T1001", status: "in_transit", revision: 3,
  origin: { id: "loc_1", name: "Gulshan", code: "GUL", status: "active" },
  destination: { id: "loc_2", name: "Mirpur", code: "MIR", status: "active" },
  expectedOn: null, reference: null, notes: null, lineCount: 100, quantity: 100, receivedQuantity: 0,
  returnedQuantity: 0, inTransitQuantity: 100, shippedAt: 1700000000, receivedAt: null, cancelledAt: null,
  createdAt: 1700000000, updatedAt: 1700000000, lines, activity: [],
} as unknown as Transfer;
type View = "purchase detail" | "transfer detail" | "purchase editor" | "transfer editor";

describe("bounded purchasing document lines", () => {
  let host: HTMLDivElement;
  let root: Root;
  let client: QueryClient;
  const originalScroll = Element.prototype.scrollIntoView;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mobile = false;
    mocks.saveOrder.mockResolvedValue({ ...order, status: "draft", revision: 4 });
    mocks.saveTransfer.mockResolvedValue({ ...transfer, status: "draft", revision: 4 });
    Element.prototype.scrollIntoView = vi.fn();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  });
  afterEach(() => {
    act(() => root.unmount());
    client.clear();
    host.remove();
    Element.prototype.scrollIntoView = originalScroll;
  });

  async function show(view: View, count = 100) {
    const node = view === "purchase detail" ? <PurchaseOrderDetail order={{ ...order, lines: order.lines.slice(0, count) }} onReload={async () => undefined} />
      : view === "transfer detail" ? <TransferDetail transfer={{ ...transfer, lines: transfer.lines.slice(0, count) }} onReload={async () => undefined} />
        : view === "purchase editor" ? <PurchaseOrderEditor order={{ ...order, lines: order.lines.slice(0, count), status: "draft" }} />
          : <TransferEditor transfer={{ ...transfer, lines: transfer.lines.slice(0, count), status: "draft" }} />;
    await act(async () => root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>));
  }
  async function type(input: HTMLInputElement, value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function click(button: HTMLElement) { await act(async () => button.click()); }
  const rows = () => [...host.querySelectorAll<HTMLElement>("[data-purchasing-line]")];
  const search = () => host.querySelector<HTMLInputElement>('input[type="search"]')!;
  const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === text)!;
  const next = () => host.querySelector<HTMLButtonElement>(`button[aria-label="${r("next")}"]`)!;
  const previous = () => host.querySelector<HTMLButtonElement>(`button[aria-label="${r("previous")}"]`)!;
  const field = (index: number, kind: "quantityFor" | "costFor" = "quantityFor") => {
    const line = lines[index - 1]!;
    const name = [line.productName, line.optionLabel].filter(Boolean).join(" · ");
    return host.querySelector<HTMLInputElement>(`input[aria-label="${t(kind, { name })}"]`)!;
  };

  it.each((["purchase detail", "transfer detail", "purchase editor", "transfer editor"] as const)
    .flatMap(view => [false, true].map(mobile => ({ view, mobile }))))("pages and searches all lines: $view / phone=$mobile", async ({ view, mobile }) => {
    mocks.mobile = mobile;
    await show(view);
    expect(rows()).toHaveLength(50);
    expect(rows()[0]!.dataset.purchasingLine).toBe("var_1");
    expect(rows().every(row => row.tagName === (mobile ? "LI" : "TR"))).toBe(true);
    await click(next());
    expect(rows()).toHaveLength(50);
    expect(rows()[0]!.dataset.purchasingLine).toBe("var_51");
    for (const query of [" Product 99 ", "INDIGO SPECIAL", "sku0099"]) {
      await type(search(), query);
      expect(rows().map(row => row.dataset.purchasingLine)).toEqual(["var_99"]);
    }
    if (view.endsWith("detail")) {
      await type(search(), "BARCODE-99");
      expect(rows().map(row => row.dataset.purchasingLine)).toEqual(["var_99"]);
    }
    await type(search(), "absent product");
    expect(rows()).toHaveLength(0);
    expect(host.querySelector('[role="status"]')?.textContent).toBe(r("noResults"));
    await type(search(), "");
    expect(rows()[0]!.dataset.purchasingLine).toBe("var_1");
  });

  it("keeps a clamped page after detail lines shrink and grow", async () => {
    await show("purchase detail", 51);
    await click(next());
    expect(rows()).toHaveLength(1);
    await show("purchase detail", 50);
    expect(rows()[0]!.dataset.purchasingLine).toBe("var_1");
    await show("purchase detail");
    expect(rows()).toHaveLength(50);
    expect(rows()[0]!.dataset.purchasingLine).toBe("var_1");
  });

  it("leaves one-line phone documents without a search or pager", async () => {
    mocks.mobile = true;
    await show("purchase detail", 1);
    expect(rows()).toHaveLength(1);
    expect(search()).toBeNull();
    expect(host.querySelector('[data-slot="pagination"]')).toBeNull();
  });

  it.each(["purchase editor", "transfer editor"] as const)("keeps full edits, totals and save body across pages: %s", async view => {
    await show(view);
    await type(field(1), "3");
    await click(next());
    await type(field(100), "4");
    mocks.mobile = true;
    await show(view);
    expect(field(100).value).toBe("4");
    await click(previous());
    expect(field(1).value).toBe("3");
    await type(search(), "SKU0100");
    expect(rows()).toHaveLength(1);
    if (view === "purchase editor") expect(host.textContent).toContain("৳1050.00");
    else expect(host.textContent).toContain(t("units", { count: 105 }));
    await click(button(t("saveDraft")));
    const save = view === "purchase editor" ? mocks.saveOrder : mocks.saveTransfer;
    expect(save).toHaveBeenCalledTimes(1);
    const sent = save.mock.calls[0]![0].body;
    expect(sent.expectedRevision).toBe(3);
    expect(sent.lines).toHaveLength(100);
    expect(sent.lines[0]).toMatchObject({ variantId: "var_1", quantity: 3 });
    expect(sent.lines[99]).toMatchObject({ variantId: "var_100", quantity: 4 });
    expect(sent.lines.slice(1, 99).every((line: { quantity: number }) => line.quantity === 1)).toBe(true);
  });

  it.each(["purchase editor", "transfer editor"] as const)("reveals the hidden invalid field and blocks saving: %s", async view => {
    await show(view);
    await click(next());
    const kind = view === "purchase editor" ? "costFor" : "quantityFor";
    await type(field(100, kind), "-1");
    await type(search(), "SKU0001");
    await click(button(t("saveDraft")));
    const save = view === "purchase editor" ? mocks.saveOrder : mocks.saveTransfer;
    expect(save).not.toHaveBeenCalled();
    expect(search().value).toBe("");
    expect(document.activeElement).toBe(field(100, kind));
    await type(search(), "SKU0001");
    await click(button(r("fixFields")));
    expect(search().value).toBe("");
    expect(rows()[0]!.dataset.purchasingLine).toBe("var_51");
    expect(document.activeElement).toBe(field(100, kind));
    expect(field(100, kind).getAttribute("aria-invalid")).toBe("true");
    // A second blocked action must reveal the same line again after navigating away.
    await type(search(), "SKU0001");
    await click(button(t(view === "purchase editor" ? "markOrdered" : "ship")));
    expect(search().value).toBe("");
    expect(document.activeElement).toBe(field(100, kind));
    expect(save).not.toHaveBeenCalled();
    await type(field(100, kind), "2");
    await click(button(t("saveDraft")));
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![0].body.lines).toHaveLength(100);
  });

  it.each(["purchase editor", "transfer editor"] as const)("reveals an added SKU behind a search and preserves the line cap: %s", async view => {
    await show(view, 99);
    await type(search(), "SKU0001");
    const add = host.querySelector<HTMLButtonElement>('button[aria-label="Add fixture SKU"]')!;
    expect(add.dataset.addedCount).toBe("99");
    await click(add);
    expect(search().value).toBe("");
    expect(rows()).toHaveLength(50);
    expect(rows().at(-1)!.dataset.purchasingLine).toBe("var_101");
    const quantity = host.querySelector<HTMLInputElement>(`input[aria-label="${t("quantityFor", { name: "New product" })}"]`)!;
    expect(document.activeElement).toBe(quantity);
    expect(quantity.value).toBe("1");
    expect(add.dataset.addedCount).toBe("100");
    expect(add.disabled).toBe(true);
  });
});
