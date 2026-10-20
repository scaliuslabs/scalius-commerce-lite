// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminApiResponseError } from "~/lib/admin-api-error";
import { translate } from "~/i18n";
import { productVariantMessages } from "~/i18n/product-variants";

const mocks = vi.hoisted(() => ({
  putCosts: vi.fn(),
  getProduct: vi.fn(),
}));
vi.mock("@scalius/api-client/sdk", () => ({
  putApiV1AdminInventoryCosts: mocks.putCosts,
  getApiV1AdminProductsById: mocks.getProduct,
}));
vi.mock("~/lib/api", () => ({ apiData: (call: unknown) => call }));

import {
  changedCosts,
  NEW_SIMPLE_SKU,
  resolveSkuKeys,
  useSkuCostDraft,
  type SkuCostStore,
} from "./sku-costs";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const variant = (id: string, sku: string, cost: number | null, extra: { isDefault?: boolean; deletedAt?: number | null } = {}) => ({
  id, sku, cost, isDefault: extra.isDefault ?? false, deletedAt: extra.deletedAt ?? null,
});

describe("changedCosts", () => {
  it("sends only changed costs of saved SKUs, each with the cost the merchant saw", () => {
    const saved = new Map<string, number | null>([["var_a", 100], ["var_b", null], ["var_c", 50]]);
    const edits = new Map<string, number | null>([["var_a", 120], ["var_b", null], ["var_c", null], ["draft_x", 30]]);
    expect(changedCosts(["var_a", "var_b", "var_c", "draft_x", "var_a"], saved, edits)).toEqual([
      { variantId: "var_a", cost: 120, expectedCost: 100 },
      { variantId: "var_c", cost: null, expectedCost: 50 },
    ]);
  });
});

describe("resolveSkuKeys", () => {
  it("finds new SKUs by their code and a new product's hidden SKU by being the default", () => {
    const resolved = resolveSkuKeys(
      [
        { key: "draft_sku_0", sku: " Mug-L ", isDefault: false },
        { key: "draft_sku_1", sku: "MUG-XL", isDefault: false },
        { key: "var_saved", sku: "MUG-S", isDefault: false },
        { key: NEW_SIMPLE_SKU, sku: "", isDefault: true },
      ],
      [
        variant("var_old_l", "MUG-L", null, { deletedAt: 1 }),
        variant("var_l", "mug-l", null),
        variant("var_default", "MUG", null, { isDefault: true }),
      ],
    );
    expect([...resolved]).toEqual([["draft_sku_0", "var_l"], [NEW_SIMPLE_SKU, "var_default"]]);
  });
});

describe("useSkuCostDraft", () => {
  let host: HTMLDivElement;
  let root: Root;
  let store: SkuCostStore;

  function Harness({ variants }: { variants: ReturnType<typeof variant>[] }) {
    store = useSkuCostDraft(variants);
    return null;
  }

  async function render(variants: ReturnType<typeof variant>[]) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => root.render(<QueryClientProvider client={client}><Harness variants={variants} /></QueryClientProvider>));
  }

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

  it("saves only the changed costs with the cost each was typed over, then shows them as saved", async () => {
    mocks.putCosts.mockResolvedValue({ items: [{ variantId: "var_a", cost: 120.5 }] });
    await render([variant("var_a", "MUG-S", 100), variant("var_b", "MUG-M", 80)]);
    store.rows.current = [
      { key: "var_a", sku: "MUG-S", isDefault: false },
      { key: "var_b", sku: "MUG-M", isDefault: false },
    ];
    act(() => {
      store.setCosts(["var_a"], 120.5);
      // Typed back to the saved cost: no change.
      store.setCosts(["var_b"], 80);
    });
    expect(store.isDirty(["var_a", "var_b"])).toBe(true);
    await act(async () => store.save("prod_1"));

    expect(mocks.putCosts).toHaveBeenCalledTimes(1);
    expect(mocks.putCosts).toHaveBeenCalledWith({ body: { items: [{ variantId: "var_a", cost: 120.5, expectedCost: 100 }] } });
    expect(store.isDirty(["var_a", "var_b"])).toBe(false);
    expect(store.costOf("var_a")).toBe(120.5);
  });

  it("hands its changed costs to the product's one write (a new variant by its draft id), then shows them as saved", async () => {
    await render([variant("var_a", "MUG-S", 100), variant("var_b", "MUG-M", 80)]);
    store.rows.current = [
      { key: "var_a", sku: "MUG-S", isDefault: false },
      { key: "var_b", sku: "MUG-M", isDefault: false },
      { key: "draft_row_l", sku: "MUG-L", isDefault: false },
    ];
    act(() => {
      store.setCosts(["var_a"], 120.5);
      store.setCosts(["var_b"], 80);
      store.setCosts(["draft_row_l"], 95);
    });
    const changes = store.changes();
    expect(changes).toEqual([
      { variantId: "var_a", cost: 120.5, expectedCost: 100 },
      { variantId: "draft_row_l", cost: 95, expectedCost: null },
    ]);
    // Nothing is sent on its own.
    expect(mocks.putCosts).not.toHaveBeenCalled();

    act(() => store.settle(changes, "prod_1"));

    expect(store.isDirty(["var_a", "var_b", "draft_row_l"])).toBe(false);
    expect(store.costOf("var_a")).toBe(120.5);
    expect(store.changes()).toEqual([]);
  });

  it("refuses a cost changed elsewhere, shows the latest one and says so", async () => {
    mocks.putCosts.mockRejectedValue(new AdminApiResponseError("A SKU's cost changed", 409, "CONFLICT"));
    mocks.getProduct.mockResolvedValue({ id: "prod_1", variants: [variant("var_a", "MUG-S", 111), variant("var_b", "MUG-M", 80)] });
    await render([variant("var_a", "MUG-S", 100), variant("var_b", "MUG-M", 80)]);
    store.rows.current = [
      { key: "var_a", sku: "MUG-S", isDefault: false },
      { key: "var_b", sku: "MUG-M", isDefault: false },
    ];
    act(() => {
      store.setCosts(["var_a"], 130);
      store.setCosts(["var_b"], 90);
    });

    let failure: unknown;
    await act(async () => {
      await store.save("prod_1").catch((error: unknown) => { failure = error; });
    });
    expect((failure as Error).message).toBe(translate(productVariantMessages, "costChanged"));
    // The cost a receipt averaged meanwhile is shown; the other typed cost stays to save again.
    expect(store.costOf("var_a")).toBe(111);
    expect(store.isDirty(["var_a"])).toBe(false);
    expect(store.costOf("var_b")).toBe(90);
    expect(store.isDirty(["var_b"])).toBe(true);
  });

  it("keeps typed costs and names the cost field when the save fails for another reason", async () => {
    mocks.putCosts.mockRejectedValue(new TypeError("Failed to fetch"));
    await render([variant("var_a", "MUG-S", null)]);
    store.rows.current = [{ key: "var_a", sku: "MUG-S", isDefault: false }];
    act(() => store.setCosts(["var_a"], 40));
    let failure: unknown;
    await act(async () => {
      await store.save("prod_1").catch((error: unknown) => { failure = error; });
    });
    expect((failure as Error).message).toContain(translate(productVariantMessages, "costPerItem"));
    expect(store.isDirty(["var_a"])).toBe(true);
  });

  it("gives a new variant's cost to the SKU the save just made", async () => {
    mocks.getProduct.mockResolvedValue({ id: "prod_1", variants: [variant("var_s", "MUG-S", 10), variant("var_l", "MUG-L", null)] });
    mocks.putCosts.mockResolvedValue({ items: [{ variantId: "var_l", cost: 55 }] });
    await render([variant("var_s", "MUG-S", 10)]);
    store.rows.current = [
      { key: "var_s", sku: "MUG-S", isDefault: false },
      { key: "draft_sku_1", sku: "MUG-L", isDefault: false },
    ];
    act(() => store.setCosts(["draft_sku_1"], 55));
    await act(async () => store.save("prod_1"));

    expect(mocks.putCosts).toHaveBeenCalledWith({ body: { items: [{ variantId: "var_l", cost: 55, expectedCost: null }] } });
    expect(store.costOf("var_l")).toBe(55);
    expect(store.isDirty(["var_l"])).toBe(false);
  });

  it("sends nothing when no cost changed", async () => {
    await render([variant("var_a", "MUG-S", 10)]);
    store.rows.current = [{ key: "var_a", sku: "MUG-S", isDefault: false }];
    await act(async () => store.save("prod_1"));
    expect(mocks.putCosts).not.toHaveBeenCalled();
    expect(mocks.getProduct).not.toHaveBeenCalled();
  });

  it("forgets typed costs on discard and follows the latest saved ones", async () => {
    await render([variant("var_a", "MUG-S", 10, { isDefault: true })]);
    expect(store.simpleKey).toBe("var_a");
    act(() => store.setCosts(["var_a"], 12));
    act(() => store.sync([variant("var_a", "MUG-S", 11, { isDefault: true })]));
    // A typed cost keeps the cost it was typed over.
    expect(store.costOf("var_a")).toBe(12);
    act(() => store.reset());
    expect(store.costOf("var_a")).toBe(10);
    act(() => store.sync([variant("var_a", "MUG-S", 11, { isDefault: true })]));
    expect(store.costOf("var_a")).toBe(11);
  });
});
