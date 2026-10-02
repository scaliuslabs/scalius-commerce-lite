// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { translate } from "~/i18n";
import { purchasingMessages } from "~/i18n/purchasing";
import type { PurchaseOrder } from "~/lib/api-query-options/purchasing";

const mocks = vi.hoisted(() => ({
  receive: vi.fn(),
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
vi.mock("@scalius/api-client/sdk", () => ({
  postApiV1AdminInventoryPurchaseOrdersByPurchaseOrderIdReceive: mocks.receive,
}));

import { PurchaseOrderReceive } from "./PurchaseOrderReceive";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const t = (key: keyof typeof purchasingMessages.en, vars?: Record<string, string | number>) => translate(purchasingMessages, key, vars);

const line = (id: string, sku: string, barcode: string | null, quantity: number, receivedQuantity: number) => ({
  id, variantId: `var_${id}`, productId: `prod_${id}`, productName: `Product ${id}`, sku, barcode, optionLabel: null,
  retired: false, position: 0, quantity, receivedQuantity, openQuantity: quantity - receivedQuantity,
  unitCost: 10, lineTotal: quantity * 10, currentCost: 10,
});

const order = {
  id: "po_1", number: 1001, displayNumber: "PO1001", status: "partially_received", revision: 4, currencyCode: "BDT",
  supplier: null, destination: { id: "loc_1", name: "Gulshan warehouse", code: "GUL", status: "active" },
  expectedOn: null, reference: null, notes: null, shipping: 0, otherCosts: 0, tax: 0,
  lineCount: 2, quantity: 8, receivedQuantity: 1, subtotal: 80, total: 80,
  lines: [line("l1", "PANJABI-L", "8901234567890", 3, 1), line("l2", "TEE-M", null, 5, 0)],
  receipts: [],
} as unknown as PurchaseOrder;

describe("receive a purchase order", () => {
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
          <PurchaseOrderReceive order={order} onReload={async () => undefined} />
        </QueryClientProvider>,
      );
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const scanField = () => document.getElementById("receive-scan") as HTMLInputElement;
  const quantityOf = (name: string) =>
    document.querySelector<HTMLInputElement>(`input[aria-label="${t("receivingFor", { name })}"]`)!;
  const button = (text: string) => [...document.querySelectorAll("button")].find((element) => element.textContent === text)!;

  async function type(input: HTMLInputElement, value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function scan(code: string) {
    await type(scanField(), code);
    await act(async () => {
      scanField().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
  }
  async function click(element: HTMLElement) {
    await act(async () => element.click());
  }

  it("counts a unit per scan by SKU or barcode and stops at what is still to come", async () => {
    await scan("panjabi-l");
    expect(quantityOf("Product l1").value).toBe("1");
    await scan(" 8901234567890 ");
    expect(quantityOf("Product l1").value).toBe("2");
    expect(scanField().value).toBe("");
    // Only 2 of 3 are still to come on that line.
    await scan("PANJABI-L");
    expect(quantityOf("Product l1").value).toBe("2");
    expect(document.getElementById("receive-scan-status")!.textContent).toBe(t("scanFull", { name: "Product l1" }));
  });

  it("warns about a code that is not on the purchase order", async () => {
    await scan("NOT-HERE");
    expect(document.getElementById("receive-scan-status")!.textContent).toBe(t("notOnPurchaseOrder", { code: "NOT-HERE" }));
    expect(quantityOf("Product l1").value).toBe("");
    expect(quantityOf("Product l2").value).toBe("");
  });

  it("sends only lines with units and replays a retry under the same operation key", async () => {
    mocks.receive
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce({ purchaseOrderId: "po_1", status: "partially_received", lines: [] });
    await type(quantityOf("Product l2"), "4");
    await click(button(t("receiveCount", { count: 4 })));

    expect(mocks.receive).toHaveBeenCalledTimes(1);
    const first = mocks.receive.mock.calls[0]![0];
    expect(first.body).toMatchObject({ lines: [{ lineId: "l2", quantity: 4 }], updateCost: false });
    expect(first.body.operationKey).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/);
    expect(document.body.textContent).toContain(t("receiveFailed"));
    expect(mocks.navigate).not.toHaveBeenCalled();

    await click(button(t("receiveCount", { count: 4 })));
    expect(mocks.receive).toHaveBeenCalledTimes(2);
    expect(mocks.receive.mock.calls[1]![0].body.operationKey).toBe(first.body.operationKey);
    expect(mocks.toastSuccess).toHaveBeenCalledWith(t("itemsReceived"));
    expect(mocks.navigate).toHaveBeenCalledWith({ to: "/admin/inventory/purchase-orders/$purchaseOrderId", params: { purchaseOrderId: "po_1" } });
  });

  it("takes a new key for a different receipt and sends the cost choice", async () => {
    mocks.receive.mockRejectedValue(new TypeError("Failed to fetch"));
    await type(quantityOf("Product l2"), "4");
    await click(button(t("receiveCount", { count: 4 })));
    await click(button(t("all")));
    await click(document.getElementById("receive-update-cost")!);
    await click(button(t("receiveCount", { count: 6 })));

    const [first, second] = mocks.receive.mock.calls.map((call) => call[0].body);
    expect(second).toMatchObject({
      lines: [{ lineId: "l1", quantity: 2 }, { lineId: "l2", quantity: 4 }],
      updateCost: true,
    });
    expect(second.operationKey).not.toBe(first.operationKey);
  });

  it("refuses a quantity above what is still to come", async () => {
    await type(quantityOf("Product l1"), "3");
    expect(document.body.textContent).toContain(t("receiveInvalid", { max: 2 }));
    // The invalid line counts for nothing: the header button stays "Receive" and sends nothing.
    await click(button(t("receive")));
    expect(mocks.receive).not.toHaveBeenCalled();
  });
});
