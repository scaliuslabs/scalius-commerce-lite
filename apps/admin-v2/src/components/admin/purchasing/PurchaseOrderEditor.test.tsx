// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { translate } from "~/i18n";
import { purchasingMessages } from "~/i18n/purchasing";
import type { PurchaseOrder } from "~/lib/api-query-options/purchasing";

const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  order: vi.fn(),
  navigate: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/admin">{children}</a>,
  useNavigate: () => mocks.navigate,
  useBlocker: () => ({ proceed: () => undefined, reset: () => undefined, status: "idle" }),
}));
vi.mock("~/lib/api", () => ({ apiData: (call: Promise<unknown>) => call }));
vi.mock("sonner", () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));
vi.mock("~/hooks/use-currency", () => ({
  useCurrency: () => ({ symbol: "৳", code: "BDT", fmt: (amount: number) => `৳${amount.toFixed(2)}` }),
}));
vi.mock("@scalius/api-client/sdk", () => ({
  getApiV1AdminInventoryLocations: async () => ({
    locations: [{ id: "loc_1", name: "Gulshan", status: "active", isDefault: true }],
  }),
  putApiV1AdminInventoryPurchaseOrdersByPurchaseOrderId: mocks.save,
  postApiV1AdminInventoryPurchaseOrdersByPurchaseOrderIdOrder: mocks.order,
}));

import { PurchaseOrderEditor } from "./PurchaseOrderEditor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const t = (key: keyof typeof purchasingMessages.en, vars?: Record<string, string | number>) => translate(purchasingMessages, key, vars);

const line = (id: string, name: string, quantity: number, unitCost: number) => ({
  id, variantId: `var_${id}`, productId: `prod_${id}`, productName: name, sku: id.toUpperCase(), barcode: null,
  optionLabel: null, retired: false, position: 0, quantity, receivedQuantity: 0, openQuantity: quantity,
  unitCost, lineTotal: 0, currentCost: unitCost,
});

const draft = {
  id: "po_1", number: 1001, displayNumber: "PO1001", status: "draft", revision: 3, currencyCode: "BDT",
  supplier: null, destination: { id: "loc_1", name: "Gulshan", code: "GUL", status: "active" },
  expectedOn: null, reference: null, notes: null, shipping: 50.5, otherCosts: 0, tax: 7.25,
  lines: [line("l1", "Cotton panjabi", 3, 12.35), line("l2", "Button pack", 7, 0.1)],
  receipts: [],
} as unknown as PurchaseOrder;

describe("purchase order editor", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    vi.clearAllMocks();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <PurchaseOrderEditor order={draft} />
        </QueryClientProvider>,
      );
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const field = (label: string) => document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  const button = (text: string) => [...document.querySelectorAll("button")].find((element) => element.textContent === text)!;
  async function type(input: HTMLInputElement, value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("totals lines with paisa costs, then shipping and tax, exactly", async () => {
    const text = () => document.body.textContent ?? "";
    // 3 × 12.35 = 37.05 and 7 × 0.10 = 0.70: subtotal 37.75, plus 50.50 shipping and 7.25 tax.
    expect(text()).toContain("৳37.05");
    expect(text()).toContain("৳0.70");
    expect(text()).toContain("৳37.75");
    expect(text()).toContain("৳95.50");

    await type(field(t("quantityFor", { name: "Cotton panjabi" })), "4");
    expect(text()).toContain("৳49.40");
    expect(text()).toContain("৳50.10");
    expect(text()).toContain("৳107.85");

    await type(field(t("costFor", { name: "Button pack" })), "0.05");
    expect(text()).toContain("৳0.35");
    expect(text()).toContain("৳107.50");
  });

  it("saves the draft with its paisa costs at the revision it opened on", async () => {
    expect(button(t("saveDraft")).disabled).toBe(true);
    mocks.save.mockResolvedValue({ ...draft, revision: 4 });
    await type(field(t("costFor", { name: "Cotton panjabi" })), "12.99");
    expect(button(t("saveDraft")).disabled).toBe(false);
    await act(async () => button(t("saveDraft")).click());

    expect(mocks.save).toHaveBeenCalledWith({
      path: { purchaseOrderId: "po_1" },
      body: expect.objectContaining({
        expectedRevision: 3,
        shipping: 50.5,
        tax: 7.25,
        lines: [
          { variantId: "var_l1", quantity: 3, unitCost: 12.99 },
          { variantId: "var_l2", quantity: 7, unitCost: 0.1 },
        ],
      }),
    });
    expect(mocks.toastSuccess).toHaveBeenCalledWith(t("draftSaved"));
    expect(button(t("saveDraft")).disabled).toBe(true);
  });

  it("keeps a draft with an unusable quantity from being sent", async () => {
    await type(field(t("quantityFor", { name: "Button pack" })), "0");
    await act(async () => button(t("markOrdered")).click());
    expect(document.body.textContent).toContain(t("quantityInvalid"));
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.order).not.toHaveBeenCalled();
  });
});
