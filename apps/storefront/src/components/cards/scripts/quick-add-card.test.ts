// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import type { ProductPageData } from "@/lib/api/product-payloads";
import { initQuickAddCards, quickAddCartLine } from "./quick-add-card";

const buyer = vi.hoisted(() => ({ read: vi.fn(), add: vi.fn(), track: vi.fn() }));
vi.mock("@/lib/api/browser-products", () => ({ fetchProductBySlugResult: buyer.read }));
vi.mock("@/store/cart", () => ({ addToCart: buyer.add, cartLineKeyFor: async () => "line_rice" }));
vi.mock("@/components/product/lib/product-analytics", () => ({ trackProductAddToCart: buyer.track }));

const simple = {
  product: {
    id: "prod_rice", slug: "rice", name: "Rice", isActive: true, deletedAt: null,
    availableForSale: true, hasVariants: false, price: 1000,
    discountType: "percentage", discountPercentage: 10, discountAmount: null,
    freeDelivery: true, imageUrl: "https://shop.test/rice.webp", imageMediaId: "med_rice",
  },
  variants: [{
    id: "sku_rice", productId: "prod_rice", isDefault: true, optionCombinationKey: null,
    deletedAt: null, stock: 8, reservedStock: 0, trackInventory: true,
    price: 1200, discountType: null, discountPercentage: null, discountAmount: null,
  }],
} as unknown as ProductPageData;

describe("card quick add", () => {
  it("adds only an available, directly resolvable SKU at its exact current price", () => {
    expect(quickAddCartLine(simple, "BDT")).toMatchObject({
      id: "prod_rice", variantId: "sku_rice", quantity: 1, price: 1080,
      image: "https://shop.test/rice.webp", imageMediaId: "med_rice",
    });
    expect(quickAddCartLine({ ...simple, product: { ...simple.product, requiresCustomization: true } }, "BDT")).toBeNull();
    expect(quickAddCartLine({ ...simple, product: { ...simple.product, hasVariants: true } }, "BDT")).toBeNull();
    expect(quickAddCartLine({ ...simple, variants: [{ ...simple.variants[0]!, stock: 0 }] }, "BDT")).toBeNull();
    expect(quickAddCartLine({ ...simple, variants: [...simple.variants, { ...simple.variants[0]!, id: "sku_other" }] }, "BDT")).toBeNull();
  });

  it("keeps a simple product on the shelf and opens the cart after adding", async () => {
    buyer.read.mockResolvedValue({ state: "found", data: simple });
    buyer.add.mockResolvedValue(true);
    const link = document.createElement("a");
    link.href = "/products/rice";
    link.dataset.cardQuickAdd = "Rice";
    document.body.append(link);
    const opened = new Promise<Event>((resolve) => document.addEventListener("open-cart", resolve, { once: true }));
    initQuickAddCards();
    link.click();
    expect(((await opened) as CustomEvent).detail).toEqual({ addedLineKey: "line_rice" });
    expect(buyer.read).toHaveBeenCalledWith("rice");
    expect(buyer.add).toHaveBeenCalledWith(expect.objectContaining({ variantId: "sku_rice", price: 1080 }));
    expect(buyer.track).toHaveBeenCalledOnce();
    expect(link.getAttribute("aria-busy")).toBeNull();
    link.remove();
  });
});
