// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BuyerUiBlock } from "@scalius/shared/plugins/buyer-ui";
import { runBuyerUiAction } from "./actions";

const { addToCart, addDiscountCode, cartLineKeyFor } = vi.hoisted(() => ({ addToCart: vi.fn(), addDiscountCode: vi.fn(), cartLineKeyFor: vi.fn(async () => "line_key") }));
vi.mock("@/store/cart", () => ({ addToCart, addDiscountCode, cartLineKeyFor }));
const fetchMock = vi.fn();
const block: BuyerUiBlock = {
  appId: "vendor.example", releaseId: "release_1", target: "checkout.actions.before",
  ui: { type: "text", text: "Example" }, attributes: [], values: {},
};
const product = {
  id: "prod_1", slug: "shirt", name: "Shirt", isActive: true, deletedAt: null,
  price: 100, discountType: null, discountPercentage: null, discountAmount: null,
};
const variant = {
  id: "var_1", productId: "prod_1", isDefault: true, deletedAt: null,
  optionCombinationKey: null, selectedOptions: [], availabilityBand: "in_stock",
  price: 80, discountType: "percentage", discountPercentage: 25, discountAmount: null,
  imageUrl: "https://img.example.test/shirt.jpg", imageMediaId: "media_1", fulfillmentKind: "physical",
};
function reply(data: unknown): Response { return Response.json({ success: true, data }); }

beforeEach(() => {
  vi.clearAllMocks();
  window.__API_BASE_URL__ = "https://api.example.test/api/v1";
  document.documentElement.dataset.marketPresence = "en-in";
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  addToCart.mockResolvedValue(true);
  addDiscountCode.mockReturnValue(true);
});
afterEach(() => { vi.unstubAllGlobals(); delete window.__API_BASE_URL__; delete document.documentElement.dataset.marketPresence; });

describe("buyer UI actions", () => {
  it("resolves the exact SKU on the store channel in the current market and uses host pricing", async () => {
    fetchMock.mockResolvedValueOnce(reply({ products: [{ id: "prod_1", slug: "shirt" }] }))
      .mockResolvedValueOnce(reply({ product, variants: [variant] }));
    await expect(runBuyerUiAction({ kind: "cart", op: "add_line", variantId: "var_1", quantity: 2 }, block))
      .resolves.toMatchObject({ message: expect.any(String) });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://api.example.test/api/v1/products?ids=var_1&limit=1&presence=en-in",
      "https://api.example.test/api/v1/products/shirt?presence=en-in",
    ]);
    expect(addToCart).toHaveBeenCalledWith(expect.objectContaining({
      id: "prod_1", variantId: "var_1", price: 60, quantity: 2,
      imageMediaId: "media_1", fulfillmentKind: "physical",
    }));
  });

  it.each([
    { product: { ...product, requiresCustomization: true }, variants: [variant] },
    { product, variants: [{ ...variant, availabilityBand: "out_of_stock" }] },
    { product, variants: [{ ...variant, id: "var_other" }] },
    { product: { ...product, isActive: false }, variants: [variant] },
  ])("refuses products requiring buyer choices and unavailable or mismatched SKUs", async (detail) => {
    fetchMock.mockResolvedValueOnce(reply({ products: [{ id: "prod_1", slug: "shirt" }] }))
      .mockResolvedValueOnce(reply(detail));
    await expect(runBuyerUiAction({ kind: "cart", op: "add_line", variantId: "var_1", quantity: 1 }, block)).rejects.toThrow();
    expect(addToCart).not.toHaveBeenCalled();
  });

  it("keeps codes local and refuses checkout mutations from account surfaces", async () => {
    await runBuyerUiAction({ kind: "cart", op: "apply_code", code: "PRIVATE" }, block);
    expect(addDiscountCode).toHaveBeenCalledWith("PRIVATE");
    // The cart drawer is a cart surface too.
    await runBuyerUiAction({ kind: "cart", op: "apply_code", code: "DRAWER" }, { ...block, target: "cart_drawer.footer" });
    expect(addDiscountCode).toHaveBeenCalledWith("DRAWER");
    await expect(runBuyerUiAction({ kind: "cart", op: "add_line", variantId: "var_1", quantity: 1 },
      { ...block, target: "account.profile" })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts body-only to the app with the buyer session and treats ui.result navigation as inert", async () => {
    fetchMock.mockResolvedValue(Response.json({ toast: { message: "Saved" }, navigate: { href: "https://bad.test" }, ui: "<script>" }));
    await expect(runBuyerUiAction({ kind: "route", route: "save", body: { private: "buyer value" } }, block))
      .resolves.toEqual({ message: "Saved" });
    expect(fetchMock).toHaveBeenCalledWith("/apps/vendor.example/save", expect.objectContaining({
      method: "POST", credentials: "same-origin", redirect: "error", body: '{"private":"buyer value"}',
    }));
    expect(addToCart).not.toHaveBeenCalled();
  });

  it("rejects routes outside the app and surfaces bounded result errors as text", async () => {
    await expect(runBuyerUiAction({ kind: "route", route: "../outside" }, block)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValue(Response.json({ errors: { note: "Choose a delivery date" } }));
    await expect(runBuyerUiAction({ kind: "route", route: "save" }, block)).rejects.toThrow("Choose a delivery date");
  });
});
