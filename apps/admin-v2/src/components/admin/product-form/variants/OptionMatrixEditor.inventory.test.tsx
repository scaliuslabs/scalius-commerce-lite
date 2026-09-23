// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProductVariant } from "@/lib/api-query-options/products";
import { translate } from "~/i18n";
import { productMessages } from "~/i18n/products";
import { OptionMatrixEditor } from "./OptionMatrixEditor";
import type { OptionMatrixEditorHandle, ProductCreateComposition } from "./option-matrix-editor-model";

const mocks = vi.hoisted(() => ({
  putApiV1AdminProductsByIdVariantsByVariantId: vi.fn(async (_input: unknown) => ({ aggregateRevision: 4 })),
  putApiV1AdminProductsByIdOptionsMatrix: vi.fn(async (_input: unknown) => ({ aggregateRevision: 4 })),
}));

vi.mock("@scalius/api-client/sdk", () => mocks);
vi.mock("@/lib/api", () => ({ apiData: (result: unknown) => result }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const defaultSku = {
  id: "var_default_prod_1",
  productId: "prod_1",
  optionCombinationKey: null,
  imageId: null,
  selectedOptions: [],
  weight: 300,
  sku: "SIMPLE-prod_1",
  price: 250,
  stock: 5,
  reservedStock: 0,
  barcode: "2000000000017",
  barcodeType: "code128",
  discountType: "percentage",
  discountPercentage: 0,
  discountAmount: 0,
  isDefault: true,
  trackInventory: false,
  version: 1,
  stockVersion: 2,
  createdAt: 0,
  updatedAt: 0,
  deletedAt: null,
} satisfies ProductVariant;

function setInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("OptionMatrixEditor inventory for products without options", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  function render(element: React.ReactElement) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return act(async () => root.render(<QueryClientProvider client={client}>{element}</QueryClientProvider>));
  }

  const trackCheckbox = () => host.querySelector<HTMLButtonElement>('button[role="checkbox"]')!;
  const quantityLabel = translate(productMessages, "quantity");
  const quantityInput = () => host.querySelector<HTMLInputElement>(`input[aria-label="${quantityLabel}"]`);

  it("tracks quantity by default on a new product and sends it with the create request", async () => {
    const onDraftChange = vi.fn<(composition: ProductCreateComposition | null) => void>();
    await render(
      <OptionMatrixEditor
        productName="Mug"
        productPrice={250}
        images={[]}
        onDraftChange={onDraftChange}
      />,
    );

    expect(host.textContent).toContain(translate(productMessages, "inventory"));
    expect(trackCheckbox().getAttribute("aria-checked")).toBe("true");
    expect(onDraftChange).toHaveBeenLastCalledWith({ defaultSku: { trackInventory: true, stock: 0 } });

    await act(async () => {
      setInput(quantityInput()!, "6");
      quantityInput()!.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(onDraftChange).toHaveBeenLastCalledWith({ defaultSku: { trackInventory: true, stock: 6 } });

    await act(async () => trackCheckbox().click());
    expect(quantityInput()).toBeNull();
    expect(onDraftChange).toHaveBeenLastCalledWith({ defaultSku: { trackInventory: false, stock: 0 } });
  });

  it("keeps an existing untracked SKU as it is and only sends quantity the merchant edited", async () => {
    const ref = React.createRef<OptionMatrixEditorHandle>();
    const onDirtyChange = vi.fn();
    await render(
      <OptionMatrixEditor
        ref={ref}
        productId="prod_1"
        productName="Mug"
        productPrice={250}
        variants={[defaultSku]}
        images={[]}
        aggregateRevision={3}
        onDirtyChange={onDirtyChange}
      />,
    );

    expect(trackCheckbox().getAttribute("aria-checked")).toBe("false");
    expect(quantityInput()).toBeNull();
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);

    await act(async () => trackCheckbox().click());
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    await act(async () => ref.current!.save());
    expect(mocks.putApiV1AdminProductsByIdVariantsByVariantId).toHaveBeenLastCalledWith({
      path: { id: "prod_1", variantId: "var_default_prod_1" },
      body: expect.not.objectContaining({ stock: expect.anything() }),
    });
    expect(mocks.putApiV1AdminProductsByIdVariantsByVariantId.mock.lastCall?.[0]).toMatchObject({
      body: { sku: "SIMPLE-prod_1", trackInventory: true, weight: 300, expectedAggregateRevision: 3 },
    });

    await act(async () => {
      setInput(quantityInput()!, "12");
      quantityInput()!.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    await act(async () => ref.current!.save(7));
    expect(mocks.putApiV1AdminProductsByIdVariantsByVariantId.mock.lastCall?.[0]).toMatchObject({
      body: { stock: 12, expectedStockVersion: 2, trackInventory: true, expectedAggregateRevision: 7 },
    });
    expect(mocks.putApiV1AdminProductsByIdOptionsMatrix).not.toHaveBeenCalled();
  });

  it("saves an optioned product without resending quantities the merchant did not change", async () => {
    const sizeOption = {
      id: "popt_size", name: "Size", position: 0, standardMapping: "size" as const,
      values: [{ id: "pval_s", value: "S", position: 0 }, { id: "pval_m", value: "M", position: 1 }],
    };
    const sized = (id: string, valueId: string, value: string, stockVersion: number): ProductVariant => ({
      ...defaultSku,
      id,
      isDefault: false,
      trackInventory: true,
      optionCombinationKey: valueId,
      sku: `MUG-${value}`,
      barcode: `MUG-${value}-BARCODE`,
      stockVersion,
      selectedOptions: [{
        optionDefinitionId: "popt_size", optionValueId: valueId, name: "Size", value,
        position: 0, valuePosition: 0, standardMapping: "size",
      }],
    });
    const ref = React.createRef<OptionMatrixEditorHandle>();
    await render(
      <OptionMatrixEditor
        ref={ref}
        productId="prod_1"
        productName="Mug"
        productPrice={250}
        options={[sizeOption]}
        variants={[sized("var_s", "pval_s", "S", 4), sized("var_m", "pval_m", "M", 9)]}
        images={[]}
        aggregateRevision={3}
      />,
    );
    expect(host.textContent).not.toContain(translate(productMessages, "trackQuantity"));

    const labelFor = (key: "priceFor" | "quantityFor") =>
      `input[aria-label="${translate(productMessages, key, { name: "S" })}"]`;
    const priceInput = host.querySelector<HTMLInputElement>(labelFor("priceFor"))!;
    await act(async () => {
      setInput(priceInput, "300");
      priceInput.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    await act(async () => ref.current!.save());
    const pricedRows = (mocks.putApiV1AdminProductsByIdOptionsMatrix.mock.lastCall?.[0] as {
      body: { variants: Array<Record<string, unknown>> };
    }).body.variants;
    expect(pricedRows.map((row) => row.price)).toEqual([300, 250]);
    expect(pricedRows.every((row) => !("stock" in row) && !("expectedStockVersion" in row))).toBe(true);

    const stockInput = host.querySelector<HTMLInputElement>(labelFor("quantityFor"))!;
    await act(async () => {
      setInput(stockInput, "8");
      stockInput.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    await act(async () => ref.current!.save());
    const stockRows = (mocks.putApiV1AdminProductsByIdOptionsMatrix.mock.lastCall?.[0] as {
      body: { variants: Array<Record<string, unknown>> };
    }).body.variants;
    expect(stockRows[0]).toMatchObject({ id: "var_s", stock: 8, expectedStockVersion: 4 });
    expect("stock" in stockRows[1]!).toBe(false);
  });
});
