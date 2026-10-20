// @vitest-environment happy-dom
// The cart drawer on a Bangla page: every word the drawer itself writes is
// Bangla and every price and count is in Bangla digits. Merchant data here is
// Bangla too, so an English word in the drawer is a missed string.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/cart/browser-api", () => ({
  previewCartDiscounts: vi.fn(async () => ({
    ok: true,
    totalDiscount: 100,
    discounts: [{ promotionId: "promo_eid", title: "ঈদের ছাড়", code: null, amount: 100, shippingAmount: 0 }],
    offers: [{
      promotionId: "promo_cap", title: "টুপি অফার", code: null, kind: "get", percentOff: 20, quantity: 1, shortfallAmount: null,
      products: [{ id: "cap", slug: "cap", name: "টুপি", variantId: "var_cap", price: 300 }],
    }],
    rejectedCodes: [],
  })),
}));

import CartFlyout, { setCartOpen } from "./CartFlyout";
import { addToCart, cartLineKeyFor, clearCart } from "@/store/cart";
import { englishTexts, latinNumbers } from "@/lib/route-tests/bangla-text";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;

const panjabi = { id: "panjabi", slug: "panjabi", name: "সুতির পাঞ্জাবি", price: 1750, variantId: "var_panjabi", quantity: 2 };
const saree = { id: "saree", slug: "saree", name: "জামদানি শাড়ি", price: 4200, variantId: "var_saree", quantity: 3 };
const suggestion = (id: string, priceVaries: boolean) => ({
  id, name: `নকশি ${id === "a" ? "কাঁথা" : "ব্যাগ"}`, slug: `slug-${id}`, price: 900, discountedPrice: 850, priceVaries,
  discountType: null, discountPercentage: 0, discountAmount: 0, imageUrl: null, imageAlt: null,
});

beforeEach(async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  document.documentElement.lang = "bn";
  document.documentElement.dataset.storeRegion = "BD";
  window.__API_BASE_URL__ = "https://api.example.test/api/v1";
  localStorage.clear();
  clearCart();
  const sareeKey = await cartLineKeyFor(saree);
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    if (String(input).includes("/products/recommendations")) {
      return new Response(JSON.stringify({ success: true, data: { reason: "also_bought", products: [suggestion("a", true), suggestion("b", false)] } }), { status: 200 });
    }
    // The store's own words for the line are the API's (in the page's language).
    return new Response(JSON.stringify({
      data: {
        issues: [{
          index: 1, cartKey: sareeKey, productId: "saree", variantId: "var_saree", code: "QUANTITY_UNAVAILABLE", action: "reduce_quantity",
          message: "জামদানি শাড়ি মাত্র ১টি বাকি।", productName: saree.name, variantLabel: null, requestedQuantity: 3, availableQuantity: 1,
        }],
      },
    }), { status: 200 });
  }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  setCartOpen(false);
  document.documentElement.lang = "";
  delete document.documentElement.dataset.storeRegion;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;

async function openWithAdd() {
  await addToCart(panjabi);
  await addToCart(saree);
  await act(async () => root.render(<CartFlyout />));
  await act(async () => {
    document.dispatchEvent(new CustomEvent("open-cart", { detail: { addedLineKey: await cartLineKeyFor(panjabi) } }));
    await vi.advanceTimersByTimeAsync(1_000);
  });
}

describe("the cart drawer on a Bangla page", () => {
  it("writes every word in Bangla and every price and count in Bangla digits", async () => {
    await openWithAdd();
    // The parts that carry the most words are really there.
    expect(dialog().querySelector("[data-cart-added]")).not.toBeNull();
    expect(dialog().querySelector('[aria-labelledby="cart-recommendations-title"]')).not.toBeNull();
    expect(dialog().textContent).toContain("ঈদের ছাড়");
    expect(dialog().textContent).toContain("পরিমাণ ১ করুন");
    expect(dialog().textContent).toContain("৳৩,৫০০");
    expect(englishTexts(dialog())).toEqual([]);
    expect(latinNumbers(dialog())).toEqual([]);
    expect(dialog().textContent).not.toMatch(/[0-9]/);
  });

  it("speaks Bangla after a removal and in the empty cart", async () => {
    await openWithAdd();
    const remove = dialog().querySelector<HTMLButtonElement>('button[aria-label="কার্ট থেকে সুতির পাঞ্জাবি সরান"]');
    expect(remove).not.toBeNull();
    await act(async () => remove!.click());
    expect(dialog().textContent).toContain("সুতির পাঞ্জাবি সরানো হয়েছে");
    expect(englishTexts(dialog())).toEqual([]);

    // Clear cart is on the cart page now; the drawer follows the emptied cart.
    await act(async () => clearCart());
    expect(dialog().textContent).toContain("কার্ট খালি");
    expect(englishTexts(dialog())).toEqual([]);
    expect(latinNumbers(dialog())).toEqual([]);
  });
});
