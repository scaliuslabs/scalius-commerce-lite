// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProductVariant } from "@/lib/api-query-options/products";
import { translate } from "~/i18n";
import { productVariantMessages } from "~/i18n/product-variants";
import { OptionMatrixEditor } from "./OptionMatrixEditor";
import type { OptionMatrixEditorHandle } from "./option-matrix-editor-model";
import { SkuCostProvider, useSkuCostDraft, type SkuCostStore } from "../sku-costs";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { PermissionProvider } from "~/contexts/PermissionContext";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  putApiV1AdminProductsByIdVariantsByVariantId: vi.fn(async (_input: unknown) => ({ aggregateRevision: 4 })),
  putApiV1AdminProductsByIdOptionsMatrix: vi.fn(async (_input: unknown) => ({ aggregateRevision: 4 })),
  putApiV1AdminInventoryCosts: vi.fn(async (_input: unknown) => ({ items: [] as unknown[] })),
  getApiV1AdminProductsById: vi.fn(),
  getApiV1AdminInventoryLocations: vi.fn(async (_input: unknown) => ({
    locations: [{ id: "loc_default", name: "Main location", isDefault: true, status: "active" }],
  })),
  getApiV1AdminInventoryLevels: vi.fn(async (_input: unknown) => ({ productId: "prod_1", levels: [] as unknown[], incoming: [] as unknown[] })),
}));

vi.mock("@scalius/api-client/sdk", () => mocks);
vi.mock("@/lib/api", () => ({ apiData: (result: unknown) => result }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
  useNavigate: () => mocks.navigate,
}));
vi.mock("@/hooks/use-currency", () => {
  const fmt = (price: number) => `৳${price}`;
  const currency = { code: "BDT", symbol: "৳", fmt, formatPrice: fmt, salePrice: () => null };
  return { useCurrency: () => currency };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const baseSku = {
  productId: "prod_1",
  optionCombinationKey: null,
  imageId: null,
  selectedOptions: [],
  weight: null,
  price: 250,
  stock: 5,
  reservedStock: 0,
  barcode: null,
  barcodeType: null,
  discountType: "percentage",
  discountPercentage: 0,
  discountAmount: 0,
  trackInventory: true,
  version: 1,
  stockVersion: 2,
  createdAt: 0,
  updatedAt: 0,
  deletedAt: null,
} as const;

const defaultSku = { ...baseSku, id: "var_default", sku: "MUG", isDefault: true, cost: 100 } as unknown as ProductVariant;
const sizeOption = {
  id: "popt_size", name: "Size", position: 0, standardMapping: "size" as const,
  values: [{ id: "pval_s", value: "S", position: 0 }, { id: "pval_m", value: "M", position: 1 }],
};
const sized = (id: string, valueId: string, value: string, cost: number | null) => ({
  ...baseSku,
  id,
  isDefault: false,
  sku: `MUG-${value}`,
  optionCombinationKey: valueId,
  cost,
  selectedOptions: [{
    optionDefinitionId: "popt_size", optionValueId: valueId, name: "Size", value,
    position: 0, valuePosition: 0, standardMapping: "size",
  }],
}) as unknown as ProductVariant;

function setInput(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("OptionMatrixEditor cost per item", () => {
  let host: HTMLDivElement;
  let root: Root;
  let store: SkuCostStore;

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

  function Page({ readOnly = false, variants, options = [], editorRef, onDirtyChange, onNavigationDirtyChange, onSaved }: {
    readOnly?: boolean;
    variants: ProductVariant[];
    options?: (typeof sizeOption)[];
    editorRef: React.Ref<OptionMatrixEditorHandle>;
    onDirtyChange?: (dirty: boolean) => void;
    onNavigationDirtyChange?: (dirty: boolean) => void;
    onSaved?: () => void;
  }) {
    store = useSkuCostDraft(variants);
    return (
      <SkuCostProvider store={store}>
        <OptionMatrixEditor
          readOnly={readOnly}
          ref={editorRef}
          productId="prod_1"
          productName="Mug"
          productPrice={250}
          options={options}
          variants={variants}
          images={[]}
          aggregateRevision={3}
          onDirtyChange={onDirtyChange}
          onNavigationDirtyChange={onNavigationDirtyChange}
          onSaved={onSaved}
        />
      </SkuCostProvider>
    );
  }

  function render(element: React.ReactElement, canViewCosts = true) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // Costs reach the editor only with "View product costs".
    return act(async () => root.render(
      <PermissionProvider permissions={canViewCosts ? [PERMISSIONS.PRODUCTS_VIEW_COSTS] : []}>
        <QueryClientProvider client={client}>{element}</QueryClientProvider>
      </PermissionProvider>,
    ));
  }

  it("revokes editing without showing unsaved SKU or cost drafts, and still gates saved costs", async () => {
    const ref = React.createRef<OptionMatrixEditorHandle>();
    const onDirtyChange = vi.fn();
    const onNavigationDirtyChange = vi.fn();
    const variants = [sized("var_s", "pval_s", "S", 10), sized("var_m", "pval_m", "M", 80)];
    const page = (readOnly: boolean) => <Page readOnly={readOnly} variants={variants} options={[sizeOption]} editorRef={ref} onDirtyChange={onDirtyChange} onNavigationDirtyChange={onNavigationDirtyChange} />;
    await render(page(false));
    const price = host.querySelector<HTMLInputElement>(`input[aria-label="${translate(productVariantMessages, "priceFor", { name: "S" })}"]`)!;
    await act(async () => {
      setInput(price, "999");
      price.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      store.setCosts(["var_s"], 777);
    });
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    await render(page(true));
    const row = host.querySelector('[data-variant-row="var_s"]')!;
    expect(row.textContent).toContain("৳250");
    expect(row.textContent).not.toContain("৳999");
    expect(host.querySelector("input:not([type=search]), [role=checkbox]")).toBeNull();
    const expand = row.querySelector<HTMLButtonElement>(`button[aria-label="${translate(productVariantMessages, "moreFieldsFor", { name: "S" })}"]`)!;
    await act(async () => expand.click());
    const cost = [...row.querySelectorAll('[data-slot="field"]')].find((field) => field.querySelector('[data-slot="field-label"]')?.textContent === translate(productVariantMessages, "costPerItem"))!;
    expect(cost.querySelector('[data-slot="field-control"]')?.textContent).toBe("৳10");
    expect(store.costOf("var_s")).toBe(777); // The route store survived the matrix remount.
    expect(store.costOf("var_s", true)).toBe(10);
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    expect(onNavigationDirtyChange).toHaveBeenLastCalledWith(true);
    expect(ref.current!.composition()).toBeNull();
    await act(async () => ref.current!.save());
    expect(mocks.putApiV1AdminProductsByIdOptionsMatrix).not.toHaveBeenCalled();
    expect(mocks.putApiV1AdminInventoryCosts).not.toHaveBeenCalled();
    await render(page(false));
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    expect(onNavigationDirtyChange).toHaveBeenLastCalledWith(true);
    expect(ref.current!.composition()).not.toBeNull();
    await render(page(true), false);
    expect(host.textContent).not.toContain(translate(productVariantMessages, "costPerItem"));
    expect(host.textContent).not.toContain("96.0%");
  });

  it("saves a changed cost of a product without options on its own, with the cost it replaces", async () => {
    const ref = React.createRef<OptionMatrixEditorHandle>();
    const onDirtyChange = vi.fn();
    const onSaved = vi.fn();
    await render(<Page variants={[defaultSku]} editorRef={ref} onDirtyChange={onDirtyChange} onSaved={onSaved} />);
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);

    // The Pricing card types into the same store.
    act(() => store.setCosts([store.simpleKey], 120.75));
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    await act(async () => ref.current!.save(3));

    expect(mocks.putApiV1AdminProductsByIdVariantsByVariantId).not.toHaveBeenCalled();
    expect(mocks.putApiV1AdminInventoryCosts).toHaveBeenCalledWith({
      body: { items: [{ variantId: "var_default", cost: 120.75, expectedCost: 100 }] },
    });
    expect(onSaved).not.toHaveBeenCalled();
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it("edits each variant's cost with its margin, and sends costs after the variants", async () => {
    const ref = React.createRef<OptionMatrixEditorHandle>();
    const onSaved = vi.fn();
    await render(
      <Page variants={[sized("var_s", "pval_s", "S", null), sized("var_m", "pval_m", "M", 80)]} options={[sizeOption]} editorRef={ref} onSaved={onSaved} />,
    );
    // M already has a cost: its margin shows under its price (250 − 80 = 68% of 250).
    expect(host.textContent).toContain(translate(productVariantMessages, "marginShort", { margin: "68.0%" }));

    const expand = host.querySelector<HTMLButtonElement>(`button[aria-label="${translate(productVariantMessages, "moreFieldsFor", { name: "S" })}"]`)!;
    await act(async () => expand.click());
    const cost = host.querySelector<HTMLInputElement>(`input[aria-label="${translate(productVariantMessages, "costFor", { name: "S" })}"]`)!;
    expect(cost.value).toBe("");
    await act(async () => setInput(cost, "55"));
    expect(host.textContent).toContain(translate(productVariantMessages, "profitAndMargin", { profit: "৳195", margin: "78.0%" }));

    const price = host.querySelector<HTMLInputElement>(`input[aria-label="${translate(productVariantMessages, "priceFor", { name: "M" })}"]`)!;
    await act(async () => {
      setInput(price, "300");
      price.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    await act(async () => ref.current!.save());

    expect(mocks.putApiV1AdminProductsByIdOptionsMatrix).toHaveBeenCalledTimes(1);
    expect(mocks.putApiV1AdminInventoryCosts).toHaveBeenCalledWith({
      body: { items: [{ variantId: "var_s", cost: 55, expectedCost: null }] },
    });
    const matrixOrder = mocks.putApiV1AdminProductsByIdOptionsMatrix.mock.invocationCallOrder[0]!;
    const costOrder = mocks.putApiV1AdminInventoryCosts.mock.invocationCallOrder[0]!;
    expect(costOrder).toBeGreaterThan(matrixOrder);
    // The page reloads the variants only once the costs are in.
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it("blocks the save on a cost below zero, naming the variant", async () => {
    const ref = React.createRef<OptionMatrixEditorHandle>();
    await render(<Page variants={[sized("var_s", "pval_s", "S", 10), sized("var_m", "pval_m", "M", 80)]} options={[sizeOption]} editorRef={ref} />);
    act(() => store.setCosts(["var_s"], -1));

    let failure: unknown;
    await act(async () => {
      await ref.current!.save().catch((error: unknown) => { failure = error; });
    });
    expect((failure as Error).message).toBe(`S: ${translate(productVariantMessages, "issueCostInvalid")}`);
    expect(mocks.putApiV1AdminProductsByIdOptionsMatrix).not.toHaveBeenCalled();
    expect(mocks.putApiV1AdminInventoryCosts).not.toHaveBeenCalled();
    // The row opens on the field that needs the change.
    expect(host.querySelector(`input[aria-label="${translate(productVariantMessages, "costFor", { name: "S" })}"]`)).not.toBeNull();
  });

  it("offers one cost for the selected variants", async () => {
    const ref = React.createRef<OptionMatrixEditorHandle>();
    await render(<Page variants={[sized("var_s", "pval_s", "S", 10), sized("var_m", "pval_m", "M", 80)]} options={[sizeOption]} editorRef={ref} />);
    const selectAll = host.querySelector<HTMLButtonElement>('button[role="checkbox"]')!;
    await act(async () => selectAll.click());
    // The "More actions" menu opens the cost panel.
    const more = Array.from(host.querySelectorAll("button")).find((button) => button.textContent?.includes("More actions"))!;
    await act(async () => {
      more.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      more.click();
    });
    const item = Array.from(document.querySelectorAll('[role="menuitem"]')).find((element) => element.textContent === translate(productVariantMessages, "editCosts"));
    expect(item).toBeDefined();
  });
});
