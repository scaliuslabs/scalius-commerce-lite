// @vitest-environment happy-dom

// A digital SKU's stock is never typed in (packages/core/src/modules/digital/README.md):
// licence keys are its stock, files are unlimited. The editor shows that instead of a
// quantity field, says when the SKU can't be sold yet, and never sends a quantity.
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProductVariant } from "@/lib/api-query-options/products";
import { translate } from "~/i18n";
import { digitalMessages } from "~/i18n/digital";
import { productVariantMessages } from "~/i18n/product-variants";
import { ProductEditorSlotsContext } from "../editor-slots";
import { ProductKindRulesContext, productKindRules } from "../product-kind-rules";
import type { ProductFulfilmentMode } from "../fulfilment-mode";
import { OptionMatrixEditor } from "./OptionMatrixEditor";
import type { OptionMatrixEditorHandle, ProductCreateComposition } from "./option-matrix-editor-model";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { PermissionProvider } from "~/contexts/PermissionContext";

type Asset = { id: string; kind: "file" | "licence_keys"; status: "draft" | "ready" | "archived"; variantId: string | null; keys?: { available: number; assigned: number } };

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  assets: [] as Asset[],
  putApiV1AdminProductsByIdVariantsByVariantId: vi.fn(async (_input: unknown) => ({ aggregateRevision: 4 })),
  putApiV1AdminProductsByIdOptionsMatrix: vi.fn(async (_input: unknown) => ({ aggregateRevision: 4 })),
  getApiV1AdminInventoryLocations: vi.fn(async (_input: unknown) => ({
    locations: [{ id: "loc_default", name: "Main location", isDefault: true, status: "active" }],
  })),
  getApiV1AdminInventoryLevels: vi.fn(async (_input: unknown) => ({ productId: "prod_1", levels: [] as unknown[] })),
  getApiV1AdminProductsByIdDigitalAssets: vi.fn(async (_input: unknown) => ({ assets: mocks.assets })),
}));

vi.mock("@scalius/api-client/sdk", () => mocks);
vi.mock("@/lib/api", () => ({ apiData: (result: unknown) => result }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
  useNavigate: () => mocks.navigate,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const d = (key: keyof (typeof digitalMessages)["en"], vars?: Record<string, string | number>) => translate(digitalMessages, key, vars);
const p = (key: keyof (typeof productVariantMessages)["en"], vars?: Record<string, string | number>) => translate(productVariantMessages, key, vars);

const defaultSku = {
  id: "var_default",
  productId: "prod_1",
  optionCombinationKey: null,
  imageId: null,
  selectedOptions: [],
  weight: null,
  sku: "EBOOK-1",
  price: 250,
  stock: 12,
  reservedStock: 0,
  barcode: null,
  barcodeType: null,
  discountType: "percentage",
  discountPercentage: 0,
  discountAmount: 0,
  isDefault: true,
  trackInventory: true,
  version: 1,
  stockVersion: 2,
  createdAt: 0,
  updatedAt: 0,
  deletedAt: null,
  fulfillmentKind: "digital",
} satisfies ProductVariant;

const pool = (variantId: string, available: number): Asset => ({ id: `pool_${variantId}`, kind: "licence_keys", status: "ready", variantId, keys: { available, assigned: 3 } });
const file: Asset = { id: "file_1", kind: "file", status: "ready", variantId: null };

describe("digital SKUs in the variant editor", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assets = [];
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  /** The product page: its kind rules, and the Inventory and Shipping cards' places. */
  function Page({ mode = "digital", children }: { mode?: ProductFulfilmentMode; children: React.ReactNode }) {
    const [inventory, setInventory] = React.useState<HTMLDivElement | null>(null);
    const [shipping, setShipping] = React.useState<HTMLDivElement | null>(null);
    const slots = React.useMemo(() => ({ inventory, shipping }), [inventory, shipping]);
    return (
      <ProductKindRulesContext.Provider value={productKindRules({ fulfillmentKind: mode })}>
        <ProductEditorSlotsContext.Provider value={slots}>
          <div data-testid="inventory-slot" ref={setInventory} />
          <div data-testid="shipping-slot" ref={setShipping} />
          <div data-testid="variants-card">{children}</div>
        </ProductEditorSlotsContext.Provider>
      </ProductKindRulesContext.Provider>
    );
  }

  async function render(element: React.ReactElement) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // A staff member who edits products (Import keys is an edit).
    await act(async () => root.render(
      <PermissionProvider permissions={[PERMISSIONS.PRODUCTS_VIEW, PERMISSIONS.PRODUCTS_EDIT, PERMISSIONS.PRODUCTS_ADJUST_STOCK]}>
        <QueryClientProvider client={client}>{element}</QueryClientProvider>
      </PermissionProvider>,
    ));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }

  const slot = (name: string) => host.querySelector<HTMLElement>(`[data-testid="${name}"]`)!;
  const quantityInput = () => host.querySelector(`input[aria-label="${p("quantity")}"]`);

  it("draws a physical product's Inventory card and weight into the page's cards", async () => {
    await render(<Page mode="physical"><OptionMatrixEditor productName="Mug" productPrice={250} images={[]} fulfilmentMode="physical" /></Page>);
    const inventory = slot("inventory-slot");
    expect(inventory.textContent).toContain(p("inventory"));
    expect(inventory.querySelector(`input[aria-label="${p("quantity")}"]`)).not.toBeNull();
    expect(slot("shipping-slot").textContent).toContain(p("weightGrams", { unit: "g" }));
    // The variants card keeps only the options.
    expect(slot("variants-card").textContent).not.toContain(p("trackQuantity"));
    expect(slot("variants-card").textContent).toContain(p("addOptions"));
  });

  it("asks a new digital product to be saved first, with no quantity and no weight", async () => {
    const onDraftChange = vi.fn<(composition: ProductCreateComposition | null) => void>();
    await render(<Page><OptionMatrixEditor productName="Ebook" productPrice={250} images={[]} fulfilmentMode="digital" onDraftChange={onDraftChange} /></Page>);
    expect(quantityInput()).toBeNull();
    expect(slot("inventory-slot").textContent).toContain(d("stockSaveFirst"));
    expect(slot("shipping-slot").textContent).toBe("");
    // A file-only SKU tracks no quantity; its first imported keys turn tracking on.
    expect(slot("inventory-slot").querySelector('button[role="checkbox"]')).toBeNull();
    expect(onDraftChange).toHaveBeenLastCalledWith({ defaultSku: { trackInventory: false, stock: 0 } });
  });

  it("shows a key pool's keys with Import keys, never a quantity, and saves without stock", async () => {
    mocks.assets = [pool("var_default", 12)];
    const ref = React.createRef<OptionMatrixEditorHandle>();
    const reveal = vi.fn();
    window.addEventListener("scalius:reveal-card", reveal);
    await render(
      <Page>
        <OptionMatrixEditor ref={ref} productId="prod_1" productName="Ebook" productPrice={250} variants={[defaultSku]} images={[]} aggregateRevision={3} fulfilmentMode="digital" />
      </Page>,
    );
    const inventory = slot("inventory-slot");
    expect(quantityInput()).toBeNull();
    expect(inventory.textContent).toContain(d("stockKeys", { count: "12" }));
    // The pool is the stock: tracking follows it, with no switch to turn it off under it.
    expect(inventory.textContent).toContain(d("stockPoolKeepsTracking"));
    expect(inventory.querySelector('button[role="checkbox"]')).toBeNull();
    expect(inventory.textContent).not.toContain(d("stockNotSellable"));
    const importKeys = [...inventory.querySelectorAll("button")].find((button) => button.textContent === d("importKeys"))!;
    await act(async () => importKeys.click());
    await act(async () => {
      await import("../DigitalKeyDialogs");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // Import keys opens the import dialog itself; it doesn't scroll to the Digital delivery card.
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(d("importTitle"));
    expect(reveal).not.toHaveBeenCalled();
    window.removeEventListener("scalius:reveal-card", reveal);
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[role="dialog"] button[data-slot="dialog-close"], [role="dialog"] button[aria-label="Close"]')?.click();
    });

    // Any other change saves the SKU, never its quantity (the keys move it).
    const skuInput = [...inventory.querySelectorAll<HTMLInputElement>("input")].find((input) => input.value === "EBOOK-1")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(skuInput, "EBOOK-1A");
      skuInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => ref.current!.save());
    expect(mocks.putApiV1AdminProductsByIdVariantsByVariantId.mock.lastCall?.[0]).toMatchObject({
      body: { trackInventory: true, sku: "EBOOK-1A" },
    });
    expect(mocks.putApiV1AdminProductsByIdVariantsByVariantId.mock.lastCall?.[0]).toEqual(
      expect.objectContaining({ body: expect.not.objectContaining({ stock: expect.anything() }) }),
    );
  });

  it("says a digital SKU can't be sold until it has a file or keys, and when its keys run out", async () => {
    await render(
      <Page>
        <OptionMatrixEditor productId="prod_1" productName="Ebook" productPrice={250} variants={[{ ...defaultSku, trackInventory: false, stock: 0 }]} images={[]} aggregateRevision={3} fulfilmentMode="digital" />
      </Page>,
    );
    expect(slot("inventory-slot").textContent).toContain(d("stockNoFile"));
    expect(slot("inventory-slot").textContent).toContain(d("stockNotSellable"));
    expect(slot("inventory-slot").textContent).toContain(d("addFile"));

    act(() => root.unmount());
    root = createRoot(host);
    mocks.assets = [file];
    await render(
      <Page>
        <OptionMatrixEditor productId="prod_1" productName="Ebook" productPrice={250} variants={[{ ...defaultSku, trackInventory: false, stock: 0 }]} images={[]} aggregateRevision={3} fulfilmentMode="digital" />
      </Page>,
    );
    expect(slot("inventory-slot").textContent).toContain(d("stockUnlimited"));
    expect(slot("inventory-slot").textContent).not.toContain(d("stockNotSellable"));

    act(() => root.unmount());
    root = createRoot(host);
    mocks.assets = [file, pool("var_default", 0)];
    await render(
      <Page>
        <OptionMatrixEditor productId="prod_1" productName="Ebook" productPrice={250} variants={[{ ...defaultSku, stock: 0 }]} images={[]} aggregateRevision={3} fulfilmentMode="digital" />
      </Page>,
    );
    // An empty ready pool blocks the sale even with a file (deliverable.ts).
    expect(slot("inventory-slot").textContent).toContain(d("stockOutOfKeys"));
  });

  it("shows each digital variant's keys or files in the table, with no quantity inputs or bulk quantity edit", async () => {
    const option = {
      id: "popt_edition", name: "Edition", position: 0, standardMapping: "none" as const,
      values: [{ id: "pval_std", value: "Standard", position: 0 }, { id: "pval_pro", value: "Pro", position: 1 }],
    };
    const edition = (id: string, valueId: string, value: string, trackInventory: boolean): ProductVariant => ({
      ...defaultSku,
      id,
      isDefault: false,
      trackInventory,
      optionCombinationKey: valueId,
      sku: `EBOOK-${value}`,
      selectedOptions: [{ optionDefinitionId: "popt_edition", optionValueId: valueId, name: "Edition", value, position: 0, valuePosition: 0, standardMapping: "none" }],
    });
    mocks.assets = [pool("var_pro", 4)];
    const ref = React.createRef<OptionMatrixEditorHandle>();
    await render(
      <Page>
        <OptionMatrixEditor
          ref={ref}
          productId="prod_1"
          productName="Ebook"
          productPrice={250}
          options={[option]}
          variants={[edition("var_std", "pval_std", "Standard", false), edition("var_pro", "pval_pro", "Pro", true)]}
          images={[]}
          aggregateRevision={3}
          fulfilmentMode="digital"
        />
      </Page>,
    );
    expect(host.querySelector(`input[aria-label="${p("quantityFor", { name: "Pro" })}"]`)).toBeNull();
    const rows = [...host.querySelectorAll("[data-variant-row]")].map((row) => row.textContent ?? "");
    expect(rows[0]).toContain(d("stockCellNotReady"));
    expect(rows[1]).toContain(d("stockCellKeys", { count: "4" }));

    const selectAll = host.querySelector<HTMLButtonElement>('button[role="checkbox"]')!;
    await act(async () => selectAll.click());
    expect(host.textContent).toContain(p("editPrices"));
    expect(host.textContent).not.toContain(p("editQuantities"));

    // A price change saves the rows with their recorded stock: no stock change is sent.
    const price = host.querySelector<HTMLInputElement>(`input[aria-label="${p("priceFor", { name: "Pro" })}"]`)!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(price, "300");
      price.dispatchEvent(new Event("input", { bubbles: true }));
      price.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    await act(async () => ref.current!.save());
    const sent = (mocks.putApiV1AdminProductsByIdOptionsMatrix.mock.lastCall?.[0] as { body: { variants: Array<Record<string, unknown>> } }).body.variants;
    expect(sent.every((variant) => !("expectedStockVersion" in variant))).toBe(true);
  });
});
