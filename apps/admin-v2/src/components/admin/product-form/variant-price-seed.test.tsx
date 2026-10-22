// @vitest-environment happy-dom

// New variants start from the product's price and compare-at price exactly as
// the merchant entered them, however many option values are added one by one,
// and the save that adds the options clears the product's own discount (buyer
// QA N1, merchant M4). Before, the product price followed the cheapest variant
// while the product discount stayed, so every added value took the discount
// again (4200, 3600, 3000…) and Save was refused for the product discount.
import { act, StrictMode, useRef, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useFormContext } from "react-hook-form";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ok = <T,>(data: T) => Promise.resolve({ data: { success: true, data }, response: { status: 200 } });
const EMPTY = { items: [], categories: [], locations: [], channels: [], products: [], brands: [], policies: [], attributes: [], blocks: [], bundles: [], product: { pageTemplate: null, emiEligible: false }, pagination: {}, id: "prod_new", aggregateRevision: 2 };
const sdk = vi.hoisted(() => new Map<string, ReturnType<typeof vi.fn>>());

vi.mock("@scalius/api-client/sdk", () =>
  new Proxy({}, {
    has: () => true,
    get: (_target, name) => {
      if (name === "__esModule") return false;
      if (name === "then") return undefined;
      const key = String(name);
      if (!sdk.has(key)) sdk.set(key, vi.fn(() => ok(EMPTY)));
      return sdk.get(key);
    },
  }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, search: _search, params: _params, ...props }: { children: ReactNode; to: string; search?: unknown; params?: unknown }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useNavigate: () => vi.fn(),
  useBlocker: () => ({ proceed: undefined, reset: undefined, status: "idle" }),
  useRouter: () => ({ navigate: vi.fn(), history: { push: vi.fn() } }),
  useRouterState: () => ({ location: { pathname: "/admin/products/new" } }),
}));

import { PermissionProvider } from "~/contexts/PermissionContext";
import { translate } from "~/i18n";
import { productVariantMessages } from "~/i18n/product-variants";
import { ProductForm } from "~/components/admin/ProductForm";
import { useSaveScope, type SaveScopeState } from "~/components/admin/shared/SaveBar";
import { SkuCostProvider, useSkuCostDraft } from "~/components/admin/product-form/sku-costs";
import { DEFAULT_PRODUCT_CONDITION, type ProductFormValues } from "~/components/admin/product-form/types";
import { OptionMatrixEditor } from "~/components/admin/product-form/variants/OptionMatrixEditor";
import type { OptionMatrixEditorHandle, ProductCreateComposition } from "~/components/admin/product-form/variants/option-matrix-editor-model";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  sdk.clear();
  notifyManager.setNotifyFunction((callback) => { act(callback); });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  notifyManager.setNotifyFunction((callback) => callback());
  vi.restoreAllMocks();
});

/** A stored price pair: base price and flat discount (price 4200, compare-at 4800 is base 4800 less 600). */
const stored = (price: number, compareAt: number | null) => compareAt === null
  ? { price, discountType: "percentage" as const, discountPercentage: 0, discountAmount: 0 }
  : { price: compareAt, discountType: "flat" as const, discountPercentage: 0, discountAmount: compareAt - price };

const baseValues = {
  name: "Metro sneakers", description: null, categoryId: "", isActive: false, freeDelivery: false,
  metaTitle: null, metaDescription: null, canonicalPath: null, noIndex: false, excludeFromSitemap: false,
  salesChannelIds: null as string[] | null, productCondition: DEFAULT_PRODUCT_CONDITION, slug: "", media: [],
  fulfillmentKind: "physical" as const, customizationSchema: [],
};

/** The saved simple product's one hidden SKU, priced as the product. */
const defaultSku = (price: number, compareAt: number | null) => ({
  id: "var_default", sku: "BEAM", stock: 20, stockVersion: 1, reservedStock: 0, trackInventory: true, weight: null,
  barcode: "4006381333931", barcodeType: "ean13", imageId: null, isDefault: true, deletedAt: null, fulfillmentKind: "physical", cost: 1500,
  selectedOptions: [],
  ...(compareAt === null
    ? { price, discountType: "percentage", discountPercentage: null, discountAmount: null }
    : { price: compareAt, discountType: "flat", discountPercentage: null, discountAmount: compareAt - price }),
});

interface Probe {
  form: ReturnType<typeof useFormContext<ProductFormValues>> | null;
  scope: SaveScopeState | null;
  composition: ProductCreateComposition | null;
}

function Page({ edit, probe, values, variants }: { edit: boolean; probe: Probe; values: Partial<ProductFormValues>; variants?: unknown[] }) {
  const costs = useSkuCostDraft(variants as never);
  const matrixRef = useRef<OptionMatrixEditorHandle>(null);
  const [createComposition, setCreateComposition] = useState<ProductCreateComposition | null>(null);
  probe.composition = createComposition;
  const [matrixDirty, setMatrixDirty] = useState(false);
  return (
    <SkuCostProvider store={costs}>
      <ProductForm
        categories={[]}
        defaultValues={values as never}
        isEdit={edit}
        aggregateRevision={edit ? 1 : undefined}
        matrixRef={matrixRef}
        createComposition={createComposition}
        optionMatrixIssue={null}
        optionMatrixDirty={matrixDirty}
        onDiscard={() => {}}
        optionManager={({ readOnly, skuImages, productName, productPrice, productCompareAt, isActive, onPricesChange, fulfilmentMode }) => (
          <>
            <Reader probe={probe} />
            <OptionMatrixEditor
              readOnly={readOnly}
              ref={matrixRef}
              productId={edit ? "prod_1" : undefined}
              aggregateRevision={edit ? 1 : undefined}
              requirePositivePrice={isActive}
              productName={productName}
              productPrice={productPrice}
              productCompareAt={productCompareAt}
              onPricesChange={onPricesChange}
              options={edit ? [] : undefined}
              variants={edit ? (variants as never) : undefined}
              images={skuImages}
              onDraftChange={edit ? undefined : setCreateComposition}
              onDirtyChange={setMatrixDirty}
              fulfilmentMode={fulfilmentMode}
            />
          </>
        )}
      />
    </SkuCostProvider>
  );
}

function Reader({ probe }: { probe: Probe }) {
  probe.scope = useSaveScope();
  probe.form = useFormContext<ProductFormValues>();
  return null;
}

async function mount(edit: boolean, values: Partial<ProductFormValues>, variants?: unknown[]): Promise<Probe> {
  const probe: Probe = { form: null, scope: null, composition: null };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(<StrictMode><QueryClientProvider client={queryClient}><PermissionProvider isSuperAdmin><Page edit={edit} probe={probe} values={values} variants={variants} /></PermissionProvider></QueryClientProvider></StrictMode>);
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  await act(async () => {});
  return probe;
}

const p = (key: string, values?: Record<string, string | number>) => translate(productVariantMessages, key as never, values as never);
const input = (label: string) => container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
const button = (text: string) => [...container.querySelectorAll("button")].find((node) => node.textContent?.includes(text))!;
const settle = async () => {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
};
const type = async (element: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
};

/** Adds an option and then its values one at a time, as the merchant does. */
async function addOption(number: number, name: string, values: string[]) {
  await act(async () => button(p(number === 1 ? "addOptions" : "addAnotherOption")).click());
  await settle();
  await type(input(p("optionName", { number })), name);
  for (const value of values) {
    const composer = input(p("addValueFor", { name }));
    await type(composer, value);
    await act(async () => { composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
    await settle();
  }
}

/** Each variant's price customers pay and compare-at price, from what the save sends. */
function pairs(variants: Array<{ price: number; discountType?: string | null; discountAmount?: number | null }>) {
  return variants.map((variant) => variant.discountType === "flat" && (variant.discountAmount ?? 0) > 0
    ? [variant.price - variant.discountAmount!, variant.price]
    : [variant.price, null]);
}

async function addColorAndSize() {
  await addOption(1, "Color", ["Graphite", "White"]);
  await addOption(2, "Size", ["40", "41"]);
}

describe("a new product that gets options value by value", () => {
  for (const compareAt of [4800, null]) {
    it(`gives every variant exactly 4200${compareAt ? " / 4800" : ""} and saves without a product discount`, async () => {
      const probe = await mount(false, { ...baseValues, ...stored(4200, compareAt) });
      await addColorAndSize();
      const variants = probe.composition?.optionMatrix?.variants ?? [];
      expect(variants).toHaveLength(4);
      expect(pairs(variants)).toEqual(Array.from({ length: 4 }, () => [4200, compareAt]));
      // The product follows its variants and keeps no discount of its own.
      expect(probe.form!.getValues(["variantPriced", "price", "discountAmount", "discountPercentage"])).toEqual([true, 4200, 0, 0]);

      await act(async () => { await probe.scope!.saveAll(); });
      const create = sdk.get("postApiV1AdminProducts");
      expect(create).toHaveBeenCalledTimes(1);
      const body = create!.mock.calls[0]![0].body;
      expect([body.discountAmount, body.discountPercentage]).toEqual([0, 0]);
      expect(pairs(body.optionMatrix.variants)).toEqual(Array.from({ length: 4 }, () => [4200, compareAt]));
    });
  }

  it("gets the entered price and compare-at back when its last option goes", async () => {
    const probe = await mount(false, { ...baseValues, ...stored(4200, 4800) });
    await addOption(1, "Color", ["Graphite", "White"]);
    expect(probe.form!.getValues("discountAmount")).toBe(0);
    await act(async () => container.querySelector<HTMLButtonElement>(`button[aria-label="${p("removeOption")}"]`)!.click());
    await settle();
    expect(probe.form!.getValues(["variantPriced", "price", "discountType", "discountAmount"])).toEqual([false, 4800, "flat", 600]);
  });
});

describe("a saved simple product that gets its first option (merchant M4)", () => {
  it("carries 2,500 / 3,000 and the cost to every new variant and clears the product discount in the same save", async () => {
    const probe = await mount(true, { ...baseValues, id: "prod_1", name: "Beam light", slug: "beam-light", slugEdited: true, ...stored(2500, 3000) }, [defaultSku(2500, 3000)]);
    await addOption(1, "Color", ["Black", "White"]);
    expect(probe.form!.getValues(["variantPriced", "price", "discountAmount"])).toEqual([true, 2500, 0]);

    await act(async () => { await probe.scope!.saveAll(); });
    const update = sdk.get("putApiV1AdminProductsById");
    expect(update).toHaveBeenCalledTimes(1);
    const body = update!.mock.calls[0]![0].body;
    expect([body.discountAmount, body.discountPercentage]).toEqual([0, 0]);
    expect(pairs(body.optionMatrix.variants)).toEqual([[2500, 3000], [2500, 3000]]);
    // Both keep the cost per item the product had; the first keeps its barcode.
    expect(body.skuCosts).toEqual(body.optionMatrix.variants.map((variant: { id: string }) => ({ variantId: variant.id, cost: 1500, expectedCost: null })));
    expect(body.optionMatrix.variants.map((variant: { barcode: string | null }) => variant.barcode)).toEqual(["4006381333931", null]);
  });
});
