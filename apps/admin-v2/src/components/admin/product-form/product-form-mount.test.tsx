// @vitest-environment happy-dom

// A product page the merchant has not touched is not "unsaved", and mounting
// it never loops a render ("Maximum update depth exceeded"):
//  - the variant editor's saved options and variants default to one shared
//    empty list, not a new `[]` per render (a parent that stores the draft
//    re-rendered it forever);
//  - every value the form sets on its own (the compare-at problem) has a
//    default, so setting it back to "none" is not a difference from the load.
import { act, StrictMode, useRef, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useFormContext } from "react-hook-form";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ok = <T,>(data: T) => Promise.resolve({ data: { success: true, data }, response: { status: 200 } });
const EMPTY = { items: [], categories: [], locations: [], channels: [], products: [], brands: [], policies: [], attributes: [], blocks: [], bundles: [], product: { pageTemplate: null, emiEligible: false }, pagination: {} };

vi.mock("@scalius/api-client/sdk", () =>
  new Proxy({}, {
    has: () => true,
    get: (_target, name) => (name === "__esModule" ? false : name === "then" ? undefined : vi.fn(() => ok(EMPTY))),
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
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { ProductForm } from "~/components/admin/ProductForm";
import { useSaveScope } from "~/components/admin/shared/SaveBar";
import { problemLine, productFieldLabel } from "~/components/admin/product-form/utils";
import { SkuCostProvider, useSkuCostDraft } from "~/components/admin/product-form/sku-costs";
import { DEFAULT_PRODUCT_CONDITION, type ProductFormValues } from "~/components/admin/product-form/types";
import { OptionMatrixEditor } from "~/components/admin/product-form/variants/OptionMatrixEditor";
import type { OptionMatrixEditorHandle, ProductCreateComposition } from "~/components/admin/product-form/variants/option-matrix-editor-model";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
let errors: string[];

beforeEach(() => {
  notifyManager.setNotifyFunction((callback) => { act(callback); });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  errors = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(" ").slice(0, 300)); });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  notifyManager.setNotifyFunction((callback) => callback());
  vi.restoreAllMocks();
});

const newValues = {
  name: "", description: null, price: null, categoryId: "", isActive: false,
  discountType: "percentage" as const, discountPercentage: 0, discountAmount: 0, freeDelivery: false,
  metaTitle: null, metaDescription: null, canonicalPath: null, noIndex: false, excludeFromSitemap: false,
  salesChannelIds: null as string[] | null, productCondition: DEFAULT_PRODUCT_CONDITION, slug: "", media: [],
  fulfillmentKind: "physical" as const, customizationSchema: [],
};

const savedValues = {
  ...newValues, id: "prod_1", name: "Clay mug", price: 120, slug: "clay-mug", slugEdited: true, isActive: true,
};

const savedOptions = [{
  id: "opt_size", name: "Size", position: 0, standardMapping: null,
  values: [{ id: "val_s", value: "S" }, { id: "val_l", value: "L" }],
}];
const savedVariant = (id: string, valueId: string, price: number) => ({
  id, sku: id.toUpperCase(), price, stock: 5, stockVersion: 1, reservedStock: 0, trackInventory: true, weight: null,
  barcode: null, barcodeType: null, discountType: "percentage", discountPercentage: null, discountAmount: null,
  imageId: null, isDefault: false, deletedAt: null, fulfillmentKind: "physical", cost: null,
  selectedOptions: [{ optionValueId: valueId, position: 0 }],
});

interface Probe {
  renders: number;
  dirty: boolean;
  form: ReturnType<typeof useFormContext<ProductFormValues>> | null;
}

/** The page's wiring as the Add and Edit routes do it: the editor reports its draft up and the page stores it. */
function Page({ edit, probe, saved = savedValues }: { edit: boolean; probe: Probe; saved?: typeof savedValues }) {
  const costs = useSkuCostDraft();
  const matrixRef = useRef<OptionMatrixEditorHandle>(null);
  const [createComposition, setCreateComposition] = useState<ProductCreateComposition | null>(null);
  const [issue, setIssue] = useState<string | null>(null);
  const [matrixDirty, setMatrixDirty] = useState(false);
  return (
    <SkuCostProvider store={costs}>
      <ProductForm
        categories={[]}
        defaultValues={edit ? saved : newValues}
        isEdit={edit}
        aggregateRevision={edit ? 1 : undefined}
        matrixRef={matrixRef}
        createComposition={createComposition}
        optionMatrixIssue={issue}
        optionMatrixDirty={matrixDirty}
        onDiscard={() => {}}
        optionManager={({ readOnly, skuImages, productName, productPrice, isActive, onPricesChange, fulfilmentMode }) => (
          <>
            <Reader probe={probe} />
            <OptionMatrixEditor
              readOnly={readOnly}
              ref={matrixRef}
              productId={edit ? "prod_1" : undefined}
              requirePositivePrice={isActive}
              productName={productName}
              productPrice={productPrice}
              onPricesChange={onPricesChange}
              options={edit ? (savedOptions as never) : undefined}
              variants={edit ? ([savedVariant("var_s", "val_s", 100), savedVariant("var_l", "val_l", 140)] as never) : undefined}
              images={skuImages}
              onDraftChange={edit ? undefined : setCreateComposition}
              onDraftIssueChange={setIssue}
              onDirtyChange={setMatrixDirty}
              fulfilmentMode={fulfilmentMode}
            />
          </>
        )}
      />
    </SkuCostProvider>
  );
}

/** Reads the save bar's state and the form, from inside the page. */
function Reader({ probe }: { probe: Probe }) {
  probe.renders += 1;
  // A loop is stopped here, so the failure is a test failure, not a hung run.
  if (probe.renders > 400) throw new Error("render loop");
  probe.dirty = Boolean(useSaveScope()?.dirty);
  probe.form = useFormContext<ProductFormValues>();
  return null;
}

async function mount(edit: boolean, saved?: typeof savedValues, readOnly = false): Promise<Probe> {
  const probe: Probe = { renders: 0, dirty: false, form: null };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(<StrictMode><QueryClientProvider client={queryClient}><PermissionProvider isSuperAdmin={!readOnly} permissions={readOnly ? [PERMISSIONS.PRODUCTS_VIEW] : undefined}><Page edit={edit} probe={probe} saved={saved} /></PermissionProvider></QueryClientProvider></StrictMode>);
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  await act(async () => {});
  return probe;
}

/** Fields whose value is not the one the page loaded with: what react-hook-form calls dirty. */
function changedFromLoad(probe: Probe): string[] {
  const values = probe.form!.getValues() as Record<string, unknown>;
  const loaded = probe.form!.formState.defaultValues as Record<string, unknown>;
  return Object.keys({ ...values, ...loaded }).filter((key) => JSON.stringify(values[key]) !== JSON.stringify(loaded[key]));
}

describe("a product page nobody has edited", () => {
  it("normalizes explicit channel sets at hydration without making null publication explicit", async () => {
    const probe = await mount(true, { ...savedValues, salesChannelIds: ["sc_online_store", "sc_meta", "sc_meta"] });
    expect(probe.form!.getValues("salesChannelIds")).toEqual(["sc_meta", "sc_online_store"]);
    expect(probe.form!.formState.defaultValues?.salesChannelIds).toEqual(["sc_meta", "sc_online_store"]);
    expect(probe.dirty).toBe(false);
  });
  it("enables variant browsing while retaining disabled sibling-card protection", async () => {
    const probe = await mount(true, savedValues, true);
    expect(container.querySelector('[data-slot="read-only-notice"]')).not.toBeNull();
    const matrix = container.querySelector("[data-option-matrix]")!;
    expect(matrix.closest("fieldset[disabled]")).toBeNull();
    const search = matrix.querySelector<HTMLInputElement>('input[type="search"]')!;
    expect(search.matches(":disabled")).toBe(false);
    expect(matrix.querySelector("input:not([type=search]), [role=checkbox]")).toBeNull();
    const expand = matrix.querySelector<HTMLButtonElement>('button[aria-label="More fields for S"]')!;
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    expand.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(false);
    search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    for (const title of ["Status", "Product organization"]) {
      const card = [...container.querySelectorAll('[data-slot="card"]')].find((node) => node.firstElementChild?.textContent === title);
      expect(card).toBeDefined();
      expect(card!.closest("fieldset[disabled]")).not.toBeNull();
      expect(card!.querySelector('[data-slot="field-control"]')).not.toBeNull();
      expect(card!.querySelector("input, select, [role=combobox]")).toBeNull();
    }
    expect(probe.dirty).toBe(false);
  });

  it("passes product view permission through to readable saved attributes", async () => {
    const value = `  Hand wash only\n${"Cotton-".repeat(80)}  `;
    const saved = { ...savedValues, attributes: [{ attributeId: "attr_material", name: "Material", value }] };
    const probe = await mount(true, saved, true);
    await vi.waitFor(() => expect(container.textContent).toContain(value));
    const field = [...container.querySelectorAll('[data-slot="field-label"]')]
      .find((node) => node.textContent === "Material")?.parentElement;
    expect(field?.querySelector('[data-slot="field-control"]')?.textContent).toBe(value);
    const card = field?.closest('[data-slot="card"]');
    expect(card).not.toBeNull();
    expect(card?.querySelector("input, select, textarea, [role=combobox]")).toBeNull();
    expect(card?.querySelectorAll("button")).toHaveLength(1); // Only the card disclosure remains.
    expect(container.querySelector("fieldset")?.disabled).toBe(true);
    expect(probe.form!.getValues("attributes")).toEqual(saved.attributes);
    expect(probe.dirty).toBe(false);
  });

  it("a new product is not unsaved and does not loop", async () => {
    const probe = await mount(false);
    expect(errors.filter((line) => /Maximum update depth|render loop/.test(line))).toEqual([]);
    expect(probe.renders).toBeLessThan(60);
    expect(changedFromLoad(probe)).toEqual([]);
    expect(probe.dirty).toBe(false);
  });

  it("a saved product with variants is not unsaved once its prices are known", async () => {
    const probe = await mount(true);
    expect(errors.filter((line) => /Maximum update depth|render loop/.test(line))).toEqual([]);
    // The variants carry the price, so the Price field gave way: its leftover state must not count as an edit.
    expect(errors.filter((line) => !/act\(|Query data cannot be undefined/.test(line))).toEqual([]);
    expect(container.textContent).toContain("৳100");
    expect(changedFromLoad(probe)).toEqual([]);
    expect(probe.dirty).toBe(false);
  });
});

describe("an empty description", () => {
  it("is one value: a saved empty paragraph or two is no change, and clearing back to empty is none either", async () => {
    for (const stored of ["<p></p>", "<p></p><p></p>"]) {
      const probe = await mount(true, { ...savedValues, description: stored } as never);
      expect(probe.form!.getValues("description")).toBeNull();
      expect(changedFromLoad(probe)).toEqual([]);
      expect(probe.dirty).toBe(false);
      act(() => root.unmount());
      root = createRoot(container);
    }
  });
});

describe("problem lines in the save banner", () => {
  it("name the field once", () => {
    expect(problemLine("Title", "Title can't be blank.")).toBe("Title can't be blank.");
    expect(problemLine("Title", "Use at least 3 characters.")).toBe("Title: Use at least 3 characters.");
    expect(problemLine("Compare-at price", "Compare-at price must be higher than the price.")).toBe("Compare-at price must be higher than the price.");
  });

  it("name a field the merchant sees by its label, not a placeholder", () => {
    expect(productFieldLabel("compareAtProblem")).toBe("Compare-at price");
  });
});
