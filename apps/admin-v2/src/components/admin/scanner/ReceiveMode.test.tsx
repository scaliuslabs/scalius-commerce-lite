// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminApiResponseError } from "~/lib/admin-api-error";
import { translate } from "~/i18n";
import { scannerMessages } from "~/i18n/scanner";

const mocks = vi.hoisted(() => ({
  onScan: null as ((code: string, format: string) => void) | null,
  listOrders: vi.fn(),
  listTransfers: vi.fn(),
  getOrder: vi.fn(),
  getTransfer: vi.fn(),
  receiveOrder: vi.fn(),
  receiveTransfer: vi.fn(),
}));
vi.mock("@scalius/api-client/sdk", () => ({
  getApiV1AdminInventoryPurchaseOrders: mocks.listOrders,
  getApiV1AdminInventoryTransfers: mocks.listTransfers,
  getApiV1AdminInventoryPurchaseOrdersByPurchaseOrderId: mocks.getOrder,
  getApiV1AdminInventoryTransfersByTransferId: mocks.getTransfer,
  postApiV1AdminInventoryPurchaseOrdersByPurchaseOrderIdReceive: mocks.receiveOrder,
  postApiV1AdminInventoryTransfersByTransferIdReceive: mocks.receiveTransfer,
}));
vi.mock("@/lib/api", () => ({ apiData: (call: unknown) => call }));
// The camera is a stub: tests hand it codes as a scanner would.
vi.mock("./BarcodeScanner", () => ({
  BarcodeScanner: ({ onScan }: { onScan: (code: string, format: string) => void }) => {
    mocks.onScan = onScan;
    return <div data-testid="camera" />;
  },
}));

import { ReceiveMode, useReceiveSession } from "./ReceiveMode";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const t = (key: keyof typeof scannerMessages.en, vars?: Record<string, string | number>) => translate(scannerMessages, key, vars);

const orderLine = (id: string, sku: string, barcode: string | null, openQuantity: number, retired = false) => ({
  id, variantId: `var_${id}`, productId: "prod_1", productName: sku === "OLD-MUG" ? "Mug" : "Panjabi", sku, barcode,
  optionLabel: sku === "OLD-MUG" ? null : "M", retired, position: 0, quantity: openQuantity, receivedQuantity: 0, openQuantity,
});

describe("ReceiveMode", () => {
  let host: HTMLDivElement;
  let root: Root;
  const feedback = { flash: vi.fn(), beep: vi.fn(), haptic: vi.fn() };
  const onReceived = vi.fn();

  function Harness() {
    const session = useReceiveSession({ locationId: null, feedback, onReceived });
    return <ReceiveMode session={session} showDestination={false} />;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listOrders.mockResolvedValue({
      purchaseOrders: [{
        id: "po_1", displayNumber: "PO1001", supplier: { id: "sup_1", name: "Dhaka Textiles" },
        destination: { id: "loc_main", name: "Main" }, quantity: 10, receivedQuantity: 7,
      }],
    });
    mocks.listTransfers.mockResolvedValue({
      transfers: [{
        id: "tr_1", displayNumber: "T1001", origin: { id: "loc_main", name: "Main" },
        destination: { id: "loc_banani", name: "Banani" }, inTransitQuantity: 4,
      }],
    });
    mocks.getOrder.mockResolvedValue({
      id: "po_1", displayNumber: "PO1001", supplier: { name: "Dhaka Textiles" }, revision: 3,
      lines: [orderLine("pol_1", "PANJABI-M", "8901234567890", 2), orderLine("pol_2", "OLD-MUG", "2000000000017", 1, true)],
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  const buttonWith = (text: string) => Array.from(host.querySelectorAll("button")).find((button) => button.textContent?.includes(text))!;
  const scan = (code: string) => act(() => mocks.onScan!(code, "keyboard"));

  async function openOrder() {
    await act(async () => root.render(<Harness />));
    await settle();
    await act(async () => buttonWith("PO1001").click());
    await settle();
  }

  it("lists open purchase orders and transfers with what is left to receive", async () => {
    await act(async () => root.render(<Harness />));
    await settle();
    expect(mocks.listOrders).toHaveBeenCalledWith({ query: { status: "open", limit: 50 } });
    expect(host.textContent).toContain("PO1001");
    expect(host.textContent).toContain("Dhaka Textiles");
    expect(host.textContent).toContain(t("toReceive", { count: 3 }));
    expect(host.textContent).toContain("T1001");
    expect(host.textContent).toContain(t("route", { from: "Main", to: "Banani" }));
    expect(host.textContent).toContain(t("toReceive", { count: 4 }));
  });

  it("counts scans by barcode or SKU up to what is open, and says why other scans don't count", async () => {
    await openOrder();
    expect(host.textContent).toContain(t("countToReceive"));

    await scan("8901234567890");
    await scan(" panjabi-m ");
    expect(feedback.flash).toHaveBeenLastCalledWith(expect.objectContaining({
      type: "success", detail: t("countedOf", { counted: 2, open: 2 }),
    }));
    await scan("8901234567890");
    expect(feedback.flash).toHaveBeenLastCalledWith(expect.objectContaining({ type: "error", title: t("allCounted") }));
    await scan("NOT-HERE");
    expect(feedback.flash).toHaveBeenLastCalledWith(expect.objectContaining({ type: "error", title: t("notOnPurchaseOrder") }));
    await scan("2000000000017");
    expect(feedback.flash).toHaveBeenLastCalledWith(expect.objectContaining({ type: "error", title: t("cantReceive") }));

    expect(host.textContent).toContain(t("lineCounted", { counted: 2, open: 2 }));
    expect(host.textContent).toContain(t("lineRetired"));
    expect(buttonWith(t("receiveUnits", { count: 2 }))).toBeDefined();
  });

  it("retries a receipt with the same operation key, then books it once and goes back to the list", async () => {
    await openOrder();
    await scan("8901234567890");
    await scan("8901234567890");
    // The cost switch is off by default; turned on, it goes with the receipt.
    const costSwitch = host.querySelector<HTMLButtonElement>('button[role="switch"]')!;
    expect(costSwitch.getAttribute("aria-checked")).toBe("false");
    await act(async () => costSwitch.click());

    // The connection drops twice (the automatic retry included): nothing is known to be booked.
    mocks.receiveOrder.mockRejectedValueOnce(new TypeError("Failed to fetch")).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await act(async () => buttonWith(t("receiveUnits", { count: 2 })).click());
    await settle();
    expect(host.textContent).toContain(t("receiveNotSaved"));
    expect(mocks.receiveOrder).toHaveBeenCalledTimes(2);
    const firstKey = mocks.receiveOrder.mock.calls[0]![0].body.operationKey as string;
    expect(mocks.receiveOrder.mock.calls[1]![0].body.operationKey).toBe(firstKey);

    // Tapping again sends the same intent with the same key, so the server can't book it twice.
    mocks.receiveOrder.mockResolvedValueOnce({ purchaseOrderId: "po_1", lines: [] });
    mocks.getOrder.mockResolvedValueOnce({
      id: "po_1", displayNumber: "PO1001", supplier: { name: "Dhaka Textiles" }, revision: 4,
      lines: [orderLine("pol_1", "PANJABI-M", "8901234567890", 0), orderLine("pol_2", "OLD-MUG", "2000000000017", 1, true)],
    });
    await act(async () => buttonWith(t("receiveUnits", { count: 2 })).click());
    await settle();
    expect(mocks.receiveOrder).toHaveBeenLastCalledWith({
      path: { purchaseOrderId: "po_1" },
      body: { operationKey: firstKey, lines: [{ lineId: "pol_1", quantity: 2 }], updateCost: true },
    });
    expect(onReceived).toHaveBeenCalledWith({ number: "PO1001", title: "Dhaka Textiles", units: 2 });
    // Only a retired SKU is left, which can't be received: the purchase order is done.
    expect(host.textContent).toContain(t("documentDone", { number: "PO1001" }));
    expect(host.textContent).toContain(t("receiveChoose"));
  });

  it("reloads a document that changed meanwhile and keeps the counts that still fit", async () => {
    await openOrder();
    await scan("8901234567890");
    await scan("8901234567890");
    mocks.receiveOrder.mockRejectedValueOnce(new AdminApiResponseError("Changed", 409, "conflict"));
    mocks.getOrder.mockResolvedValueOnce({
      id: "po_1", displayNumber: "PO1001", supplier: { name: "Dhaka Textiles" }, revision: 4,
      lines: [orderLine("pol_1", "PANJABI-M", "8901234567890", 1)],
    });
    await act(async () => buttonWith(t("receiveUnits", { count: 2 })).click());
    await settle();
    // A refusal is not retried.
    expect(mocks.receiveOrder).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain(t("receiveChanged", { number: "PO1001" }));
    expect(host.textContent).toContain(t("lineCounted", { counted: 1, open: 1 }));
    expect(buttonWith(t("receiveUnitsOne"))).toBeDefined();
  });
});
