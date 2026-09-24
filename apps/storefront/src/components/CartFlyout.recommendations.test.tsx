// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/cart/browser-api", () => ({
  previewCartDiscounts: vi.fn(async () => ({ ok: false, message: null })),
}));

import CartFlyout, { setCartOpen } from "./CartFlyout";
import { addToCart, clearCart } from "@/store/cart";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const card = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: `Product ${id}`,
  slug: `slug-${id}`,
  price: 500,
  discountedPrice: 450,
  priceVaries: false,
  discountType: null,
  discountPercentage: 0,
  discountAmount: 0,
  imageUrl: null,
  imageAlt: null,
  ...extra,
});

let root: Root;
let host: HTMLDivElement;
let recommendationUrls: string[];
let recommendationResponse: unknown;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  window.__API_BASE_URL__ = "https://api.example.test/api/v1";
  recommendationUrls = [];
  recommendationResponse = {
    success: true,
    data: { reason: "also_bought", products: [card("belt"), card("shirt"), card("socks", { priceVaries: true })] },
  };
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const url = String(input);
    if (url.includes("/products/recommendations")) {
      recommendationUrls.push(url);
      return new Response(JSON.stringify(recommendationResponse), { status: 200 });
    }
    return new Response(JSON.stringify({ data: { issues: [] } }), { status: 200 });
  }));
  localStorage.clear();
  clearCart();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  setCartOpen(false);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function openDrawer() {
  await act(async () => root.render(<CartFlyout />));
  await act(async () => setCartOpen(true));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
}

const row = () => document.querySelector<HTMLElement>('[aria-labelledby="cart-recommendations-title"]');

describe("cart drawer recommendations", () => {
  it("fetches once the drawer opens with items and links suggestions that are not in the cart", async () => {
    addToCart({ id: "trouser", slug: "trouser", name: "Trouser", price: 900, variantId: "var_trouser", quantity: 1 });
    addToCart({ id: "shirt", slug: "shirt", name: "Shirt", price: 500, variantId: "var_shirt", quantity: 1 });
    await act(async () => root.render(<CartFlyout />));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(recommendationUrls).toHaveLength(0);

    await openDrawer();

    expect(recommendationUrls).toHaveLength(1);
    const url = new URL(recommendationUrls[0]!);
    expect(url.searchParams.get("productIds")).toBe("shirt,trouser");
    expect(url.searchParams.get("limit")).toBe("4");
    expect(row()?.querySelector("h3")?.textContent).toBe("Customers also bought");
    const links = [...row()!.querySelectorAll("a")].map((link) => link.getAttribute("href"));
    expect(links).toEqual(["/products/slug-belt", "/products/slug-socks"]);
    expect(row()?.textContent).toContain("From ");
  });

  it("does not ask for suggestions for an empty cart", async () => {
    await openDrawer();
    expect(recommendationUrls).toHaveLength(0);
    expect(row()).toBeNull();
  });

  it("leaves the row out when the API has nothing to suggest", async () => {
    recommendationResponse = { success: true, data: { reason: "similar", products: [] } };
    addToCart({ id: "lamp", slug: "lamp", name: "Lamp", price: 900, variantId: "var_lamp", quantity: 1 });
    await openDrawer();
    expect(recommendationUrls).toHaveLength(1);
    expect(row()).toBeNull();
  });
});
