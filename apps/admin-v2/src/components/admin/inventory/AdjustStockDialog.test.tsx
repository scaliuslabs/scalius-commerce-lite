// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { translate } from "~/i18n";
import { inventoryMessages } from "~/i18n/inventory";
import { AdminApiResponseError } from "~/lib/admin-api-error";
import type { InventoryVariant } from "~/lib/api-query-options/inventory";

const mocks = vi.hoisted(() => ({
  adjust: vi.fn(),
  stockSet: vi.fn(),
  alertLevel: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("~/lib/api", () => ({ apiData: (call: Promise<unknown>) => call }));
vi.mock("sonner", () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));
vi.mock("@scalius/api-client/sdk", () => ({
  postApiV1AdminInventoryByVariantIdAdjust: mocks.adjust,
  postApiV1AdminInventoryStockSet: mocks.stockSet,
  putApiV1AdminInventoryByVariantIdAlertLevel: mocks.alertLevel,
}));

import { AdjustStockDialog } from "./AdjustStockDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const t = (key: keyof typeof inventoryMessages.en) => translate(inventoryMessages, key);

const variant = {
  id: "var_1", productId: "prod_1", productName: "Cotton panjabi", sku: "PANJABI-L-WHITE", optionLabel: "L / White",
  barcode: null, barcodeType: null, price: 2500, stock: 13, reservedStock: 0, available: 13, lowStockThreshold: null, version: 1,
} as InventoryVariant;

describe("adjust stock dialog", () => {
  let host: HTMLDivElement;
  let root: Root;
  let onSaved: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    onSaved = vi.fn<() => void>();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root.render(<AdjustStockDialog variant={variant} open onClose={() => undefined} onSaved={onSaved} />);
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const field = (id: string) => document.getElementById(id) as HTMLInputElement;
  const apply = () => [...document.querySelectorAll("button")].find((button) => button.textContent === t("apply"))!;
  const reasonText = () => field("inventory-adjustment-reason").textContent;
  async function type(id: string, value: string) {
    const input = field(id);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function submit() {
    await act(async () => {
      document.getElementById("inventory-adjustment-form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
  }

  it("switches to a removal reason when the quantity goes negative, and back", async () => {
    expect(reasonText()).toBe(t("reason_received"));
    await type("inventory-adjustment-amount", "-13");
    expect(reasonText()).toBe(t("reason_damage"));
    expect(apply().disabled).toBe(false);
    await type("inventory-adjustment-amount", "4");
    expect(reasonText()).toBe(t("reason_received"));
  });

  it("says what to type for text that isn't a whole number and keeps Apply off", async () => {
    await type("inventory-adjustment-amount", "abc");
    expect(document.body.textContent).toContain(t("wholeNumber"));
    expect(apply().disabled).toBe(true);
    await type("inventory-adjustment-amount", "-14");
    expect(document.body.textContent).toContain(t("belowZero"));
    expect(apply().disabled).toBe(true);
  });

  it("reads Bangla digits and commas as the quantity", async () => {
    mocks.adjust.mockResolvedValue({});
    await type("inventory-adjustment-amount", "১,২");
    await submit();
    expect(mocks.adjust).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({ delta: 12, reason: "received" }),
    }));
    expect(mocks.toastSuccess).toHaveBeenCalledWith(t("stockUpdated"));
  });

  it("puts a rejected reason at the reason field in plain words and focuses it", async () => {
    const raw = JSON.stringify([{ code: "invalid_value", path: ["reason"], message: "Invalid option: expected one of" }]);
    mocks.adjust.mockRejectedValue(new AdminApiResponseError(raw, 400));
    await type("inventory-adjustment-amount", "-2");
    await submit();

    expect(document.body.textContent).toContain(t("chooseReason"));
    expect(document.body.textContent).not.toContain("invalid_value");
    expect(document.activeElement).toBe(field("inventory-adjustment-reason"));
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("saves only the alert level when stock is unchanged", async () => {
    mocks.alertLevel.mockResolvedValue({ variantId: "var_1", lowStockThreshold: 5 });
    await type("inventory-alert-level", "5");
    await submit();

    expect(mocks.alertLevel).toHaveBeenCalledWith({ path: { variantId: "var_1" }, body: { lowStockThreshold: 5 } });
    expect(mocks.adjust).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).toHaveBeenCalledWith(t("alertLevelSaved"));
    expect(onSaved).toHaveBeenCalled();
  });

  it("blocks an alert level outside 0 to 1,000,000", async () => {
    await type("inventory-alert-level", "1000001");
    expect(document.body.textContent).toContain(t("alertLevelInvalid"));
    expect(apply().disabled).toBe(true);
  });
});
