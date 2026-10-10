// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { translate } from "~/i18n";
import { purchasingMessages } from "~/i18n/purchasing";
import type { PurchaseOrder, Transfer } from "~/lib/api-query-options/purchasing";

const mocks = vi.hoisted(() => ({ canEdit: false, canViewCosts: true }));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/admin">{children}</a>,
  useNavigate: () => () => undefined,
  useBlocker: () => ({ proceed: () => undefined, reset: () => undefined, status: "idle" }),
}));
vi.mock("~/hooks/use-catalog-action-permissions", () => ({
  useCatalogActionPermissions: () => ({
    inventory: {
      canAdjustStock: mocks.canEdit,
      canAcknowledgeAlerts: mocks.canEdit,
      canViewCosts: mocks.canViewCosts,
      canEditCosts: mocks.canEdit && mocks.canViewCosts,
      canManageOperations: mocks.canEdit,
      canDraftPurchaseOrders: mocks.canEdit && mocks.canViewCosts,
      canManageLocations: mocks.canEdit,
    },
  }),
}));
vi.mock("~/hooks/use-currency", () => ({
  useCurrency: () => ({ symbol: "৳", code: "BDT", fmt: (amount: number) => `৳${amount.toFixed(2)}` }),
}));
vi.mock("~/components/admin/layout/store-identity", () => ({ useStoreIdentity: () => ({ name: "Kori", host: "" }) }));
vi.mock("~/lib/api", () => ({ apiData: (call: Promise<unknown>) => call }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@scalius/api-client/sdk", () => ({
  getApiV1AdminInventoryLocations: async () => ({
    locations: [
      { id: "loc_1", name: "Gulshan", status: "active", isDefault: true },
      { id: "loc_2", name: "Mirpur", status: "active", isDefault: false },
    ],
  }),
  getApiV1AdminInventoryPurchaseOrders: async () => ({
    purchaseOrders: [{
      id: "po_1", number: 1001, displayNumber: "PO1001", status: "ordered", supplier: null,
      destination: { id: "loc_1", name: "Gulshan" }, expectedOn: null, reference: null, currencyCode: "BDT",
      lineCount: 1, quantity: 5, receivedQuantity: 0, subtotal: 50, total: 50, revision: 2,
      orderedAt: null, receivedAt: null, cancelledAt: null, createdAt: 1_700_000_000, updatedAt: 1_700_000_000,
    }],
    pagination: { page: 1, limit: 50, total: 1, totalPages: 1 },
  }),
}));

import { PurchaseOrderDetail } from "./PurchaseOrderDetail";
import { PurchaseOrderList } from "./PurchaseOrderList";
import { TransferDetail } from "./TransferDetail";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const t = (key: keyof typeof purchasingMessages.en) => translate(purchasingMessages, key);

const order = {
  id: "po_1", number: 1001, displayNumber: "PO1001", status: "partially_received", revision: 4, currencyCode: "BDT",
  supplier: { id: "sup_1", name: "Dhaka Textiles", status: "active", phone: "01711000000", email: null, contactName: null },
  destination: { id: "loc_1", name: "Gulshan", code: "GUL", status: "active" },
  expectedOn: "2026-10-31", reference: "INV-9", notes: null, shipping: 0, otherCosts: 0, tax: 0,
  lineCount: 1, quantity: 5, receivedQuantity: 2, subtotal: 50, total: 50,
  orderedAt: 1_700_000_000, receivedAt: null, cancelledAt: null, createdAt: 1_700_000_000, updatedAt: 1_700_000_000,
  lines: [{
    id: "pol_1", variantId: "var_1", productId: "prod_1", productName: "Cotton panjabi", sku: "PANJABI-L", barcode: null,
    optionLabel: "L", retired: false, position: 0, quantity: 5, receivedQuantity: 2, openQuantity: 3,
    unitCost: 10, lineTotal: 50, currentCost: 10,
  }],
  receipts: [],
} as unknown as PurchaseOrder;

const transfer = {
  id: "tr_1", number: 1001, displayNumber: "T1001", status: "in_transit", revision: 2,
  origin: { id: "loc_1", name: "Gulshan", code: "GUL", status: "active" },
  destination: { id: "loc_2", name: "Mirpur", code: "MIR", status: "active" },
  expectedOn: null, reference: null, notes: null, lineCount: 1, quantity: 4, receivedQuantity: 0, returnedQuantity: 0,
  inTransitQuantity: 4, shippedAt: 1_700_000_000, receivedAt: null, cancelledAt: null, createdAt: 1_700_000_000, updatedAt: 1_700_000_000,
  lines: [{
    id: "trl_1", variantId: "var_1", productId: "prod_1", productName: "Cotton panjabi", sku: "PANJABI-L", barcode: null,
    optionLabel: "L", retired: false, position: 0, quantity: 4, shippedQuantity: 4, receivedQuantity: 0, returnedQuantity: 0, inTransitQuantity: 4,
  }],
  activity: [],
} as unknown as Transfer;

describe("purchasing write actions follow inventory.manage; money follows products.view_costs", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    mocks.canViewCosts = true;
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  async function render(node: ReactNode) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
    });
  }
  const has = (text: string) => [...host.querySelectorAll("a, button")].some((element) => element.textContent === text);

  it.each([true, false])("purchase order: Receive and editing only with permission (%s)", async (canEdit) => {
    mocks.canEdit = canEdit;
    await render(<PurchaseOrderDetail order={order} onReload={async () => undefined} />);
    expect(host.textContent).toContain("PANJABI-L");
    expect(has(t("receive"))).toBe(canEdit);
    expect(has(t("edit"))).toBe(canEdit);
    expect(host.querySelector("[data-slot=read-only-notice]") !== null).toBe(!canEdit);
    // Viewing stays open to everyone.
    expect(has(t("moreActions"))).toBe(true);
  });

  it.each([true, false])("transfer: Receive and Cancel only with permission (%s)", async (canEdit) => {
    mocks.canEdit = canEdit;
    await render(<TransferDetail transfer={transfer} onReload={async () => undefined} />);
    expect(host.textContent).toContain("PANJABI-L");
    expect(has(t("receive"))).toBe(canEdit);
    expect(has(t("cancelTransfer"))).toBe(canEdit);
  });

  it.each([true, false])("purchase order list: Create only with permission (%s)", async (canEdit) => {
    mocks.canEdit = canEdit;
    await render(<PurchaseOrderList tab="all" onTabChange={() => undefined} onSupplierChange={() => undefined} />);
    await vi.waitFor(() => expect(host.textContent).toContain("PO1001"));
    expect(has(t("createPurchaseOrder"))).toBe(canEdit);
    expect(has(t("suppliers"))).toBe(true);
  });

  it("shows no purchase-order money without View product costs", async () => {
    mocks.canEdit = true;
    mocks.canViewCosts = false;
    // What the API sends such a caller: the order without any money field.
    const { subtotal: _s, total: _t, shipping: _sh, otherCosts: _o, tax: _x, ...withoutMoney } = order as unknown as Record<string, unknown>;
    const costless = {
      ...withoutMoney,
      lines: order.lines.map(({ unitCost: _u, lineTotal: _l, currentCost: _c, ...line }) => line),
    } as unknown as PurchaseOrder;
    await render(<PurchaseOrderDetail order={costless} onReload={async () => undefined} />);
    expect(host.textContent).toContain("PANJABI-L");
    expect(host.textContent).not.toContain(t("costSummary"));
    expect(host.textContent).not.toContain("৳");
    // Receiving still works; the supplier's printed copy and editing the extra costs don't.
    expect(has(t("receive"))).toBe(true);
    expect(has(t("edit"))).toBe(false);
  });

  it("drops the Total column and Create from the list without View product costs", async () => {
    mocks.canEdit = true;
    mocks.canViewCosts = false;
    await render(<PurchaseOrderList tab="all" onTabChange={() => undefined} onSupplierChange={() => undefined} />);
    await vi.waitFor(() => expect(host.textContent).toContain("PO1001"));
    expect(host.textContent).not.toContain(t("colTotal"));
    expect(host.textContent).not.toContain("৳");
    expect(has(t("createPurchaseOrder"))).toBe(false);
  });
});
