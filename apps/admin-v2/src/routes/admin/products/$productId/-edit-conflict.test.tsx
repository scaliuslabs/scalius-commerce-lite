// @vitest-environment happy-dom
import { act, useEffect, useState, type ComponentProps, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { ProductForm } from "~/components/admin/ProductForm";
import type { ProductRevisionConflictDialog } from "~/components/admin/product-form/ProductRevisionConflictDialog";
import type { OptionMatrixEditor } from "~/components/admin/product-form/variants/OptionMatrixEditor";

const fixture = vi.hoisted(() => ({
  fetchQuery: vi.fn(),
  product: {
    id: "p1", name: "Product", description: "", price: 10, slug: "product", aggregateRevision: 1,
    options: [], variants: [{ id: "sku1", price: 10, fulfillmentKind: "physical", deletedAt: null }],
  },
  dialog: null as ComponentProps<typeof ProductRevisionConflictDialog> | null,
  mounts: 0,
}));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: object) => ({ options, useParams: () => ({ productId: "p1" }) }),
  redirect: vi.fn(), useNavigate: () => vi.fn(),
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ fetchQuery: fixture.fetchQuery }),
  useSuspenseQuery: (options: { queryKey: string[] }) => ({ data: options.queryKey[0] === "product" ? fixture.product : { categories: [] } }),
}));
vi.mock("~/lib/api-query-options/products", () => ({ productQueryOptions: () => ({ queryKey: ["product"] }) }));
vi.mock("~/lib/api-query-options/categories", () => ({ categoryFormOptionsQueryOptions: () => ({ queryKey: ["categories"] }) }));
vi.mock("~/lib/api-query-options/settings", () => ({ seoSettingsQueryOptions: vi.fn() }));
vi.mock("~/components/admin/product-form/utils", () => ({ productFieldLabel: (field: string) => field }));
vi.mock("~/components/admin/ProductForm", () => ({
  ProductForm: (props: ComponentProps<typeof ProductForm>) => {
    props.draftRef!.current = () => ({
      changed: [], changedSections: [], rebase: vi.fn(),
      prepareSectionsRebase: async () => ({ overlaps: [], apply: vi.fn() }),
    });
    return <>
      <button onClick={() => props.onRevisionConflict?.({ expectedRevision: 1, currentRevision: 2 })}>Conflict</button>
      {props.optionManager({ skuImages: [], productName: "Product", productPrice: 10, isActive: false, onPricesChange: () => {}, fulfilmentMode: "physical" })}
    </>;
  },
}));
vi.mock("~/components/admin/product-form/ProductRevisionConflictDialog", () => ({
  ProductRevisionConflictDialog: (props: ComponentProps<typeof ProductRevisionConflictDialog>) => {
    fixture.dialog = props;
    return null;
  },
}));
vi.mock("~/components/admin/product-form/variants/OptionMatrixEditor", () => ({
  OptionMatrixEditor: (props: ComponentProps<typeof OptionMatrixEditor>) => {
    const [draft, setDraft] = useState("");
    useEffect(() => { fixture.mounts++; }, []);
    return <button id="sku" onClick={() => { setDraft("my SKU draft"); props.onDirtyChange?.(true); }}>{draft || "Edit SKU"}</button>;
  },
}));
import { Route } from "./edit";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("Apply product conflict while editing SKUs", () => {
  it.each([false, true])("keeps a new SKU draft made while loading (remote SKU change: %s)", async (remoteSkuChanged) => {
    fixture.mounts = 0;
    let finish!: (value: unknown) => void;
    fixture.fetchQuery.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const host = document.createElement("div");
    const root = createRoot(host);
    const Page = Route.options.component as ComponentType;
    await act(async () => { root.render(<Page />); });
    act(() => (host.querySelector("button") as HTMLButtonElement).click());
    let applying!: Promise<void>;
    act(() => { applying = fixture.dialog!.onApplyMine!(); });
    // Escape can close the pending dialog, allowing the merchant to edit a SKU.
    act(() => fixture.dialog!.onOpenChange(false));
    act(() => (host.querySelector("#sku") as HTMLButtonElement).click());
    await act(async () => {
      finish({ ...fixture.product, aggregateRevision: 2, variants: remoteSkuChanged
        ? [{ ...fixture.product.variants[0], price: 20 }]
        : fixture.product.variants });
      await applying;
    });
    expect(host.querySelector("#sku")?.textContent).toBe("my SKU draft");
    expect(fixture.mounts).toBe(1);
    if (remoteSkuChanged) expect(fixture.dialog!.overlap).toHaveLength(1);
    else expect(fixture.dialog!.conflict).toBeNull();
    act(() => root.unmount());
  });
});
