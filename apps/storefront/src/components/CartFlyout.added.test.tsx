// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/cart/browser-api", () => ({
  previewCartDiscounts: vi.fn(async () => ({ ok: false, message: null })),
}));

import CartFlyout, { setCartOpen } from "./CartFlyout";
import { addToCart, cartLineKeyFor, clearCart } from "@/store/cart";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: { issues: [] } }), { status: 200 })));
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

const trouser = { id: "trouser", slug: "trouser", name: "Trouser", price: 900, variantId: "var_trouser", quantity: 1 };
const shirt = { id: "shirt", slug: "shirt", name: "Blue Shirt", price: 500, variantId: "var_shirt", quantity: 2 };

async function mount() {
  await addToCart(trouser);
  await addToCart(shirt);
  await act(async () => root.render(<CartFlyout />));
}

async function dispatchOpenCart(detail?: { addedLineKey?: string; addedCount?: number }) {
  await act(async () => {
    document.dispatchEvent(new CustomEvent("open-cart", detail ? { detail } : undefined));
    await vi.advanceTimersByTimeAsync(500);
  });
}

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
const status = () => [...dialog().querySelectorAll<HTMLElement>('[role="status"]')];
const link = (label: string) =>
  [...dialog().querySelectorAll<HTMLAnchorElement>("a")].find((a) => a.textContent?.trim() === label);

describe("cart drawer after an add", () => {
  it("says how many products one action added, not just the first one's name", async () => {
    await mount();
    await dispatchOpenCart({ addedLineKey: await cartLineKeyFor(shirt), addedCount: 2 });

    expect(status().some((region) => region.textContent?.includes("2 products added to your cart"))).toBe(true);
    expect(status().some((region) => region.textContent?.includes("Blue Shirt added"))).toBe(false);
    expect(document.getElementById(dialog().getAttribute("aria-describedby")!)?.textContent).toContain("2 products were added");
  });

  it("confirms the added line, announces it politely, and links to the cart and checkout", async () => {
    await mount();
    await dispatchOpenCart({ addedLineKey: await cartLineKeyFor(shirt) });

    expect(dialog().textContent).toContain("Added to your cart");
    const announcement = status().find((region) => region.textContent?.includes("Blue Shirt"));
    expect(announcement?.textContent).toContain("Blue Shirt added to your cart");
    // The added line comes first and is the current one.
    const lines = [...dialog().querySelectorAll<HTMLElement>("[aria-current]")];
    expect(lines).toHaveLength(1);
    expect(lines[0]!.textContent).toContain("Blue Shirt");
    expect(lines[0]!.parentElement!.firstElementChild).toBe(lines[0]);
    expect(dialog().getAttribute("aria-describedby")).toBeTruthy();
    expect(document.getElementById(dialog().getAttribute("aria-describedby")!)?.textContent).toContain("Blue Shirt was added");

    expect(link("View cart")?.getAttribute("href")).toBe("/cart");
    expect(link("Check out")?.getAttribute("href")).toBe("/cart#checkoutFormCard");
    expect(dialog().textContent).toContain("Continue shopping");
    // One primary action; Clear cart lives on the cart page; the phone sheet has room for lines.
    expect(dialog().textContent).not.toContain("Clear cart");
    expect(dialog().className).toContain("h-[85dvh]");
    expect(dialog().textContent).toContain("Subtotal");
  });

  it("adds only what is left when the buyer asked for more, and says so instead of an error", async () => {
    const mug = { id: "mug", slug: "mug", name: "Mug", price: 499, variantId: "var_mug", quantity: 41 };
    await addToCart(mug);
    const mugKey = await cartLineKeyFor(mug);
    vi.mocked(fetch).mockImplementation(async (_input, init) => {
      const lines = JSON.parse(String(init?.body)).items as Array<{ cartKey: string; quantity: number }>;
      const asked = lines.find((line) => line.cartKey === mugKey)?.quantity ?? 0;
      return new Response(JSON.stringify({
        data: {
          issues: asked > 40
            ? [{ index: 0, cartKey: mugKey, productId: "mug", variantId: "var_mug", code: "quantity_unavailable", action: "reduce_quantity",
                message: "Only 40 left for Mug.", productName: "Mug", variantLabel: null, requestedQuantity: asked, availableQuantity: 40 }]
            : [],
        },
      }), { status: 200 });
    });
    await act(async () => root.render(<CartFlyout />));
    await dispatchOpenCart({ addedLineKey: mugKey });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });

    const { cartStore } = await import("@/store/cart");
    expect(cartStore.get().items[mugKey]?.quantity).toBe(40);
    expect(dialog().querySelector("[data-cart-added-text]")?.textContent).toBe("Added 40 (all that's left)");
    expect(dialog().textContent).not.toContain("Added to your cart");
    // The capped line is buyable: no error stays on it.
    expect(dialog().textContent).not.toContain("Only 40 left");
  });

  // Buyer QA m2: an answer read for the asked 41 (a check still on its way)
  // must not say "Only 40 left" beside a line that already holds 40.
  it("never shows an 'only N left' the capped line already follows", async () => {
    const mug = { id: "mug", slug: "mug", name: "Mug", price: 499, variantId: "var_mug", quantity: 41 };
    await addToCart(mug);
    const mugKey = await cartLineKeyFor(mug);
    vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({
      data: {
        issues: [{ index: 0, cartKey: mugKey, productId: "mug", variantId: "var_mug", code: "quantity_unavailable", action: "reduce_quantity",
          message: "Only 40 left for Mug.", productName: "Mug", variantLabel: null, requestedQuantity: 41, availableQuantity: 40 }],
      },
    }), { status: 200 }));
    await act(async () => root.render(<CartFlyout />));
    await dispatchOpenCart({ addedLineKey: mugKey });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(dialog().querySelector("[data-cart-added-text]")?.textContent).toBe("Added 40 (all that's left)");
    expect(dialog().textContent).not.toContain("Only 40 left");
  });

  it("shows the plain cart, with no confirmation, for a bare open-cart", async () => {
    await mount();
    await dispatchOpenCart();

    expect(dialog().textContent).not.toContain("Added to your cart");
    expect(status().some((region) => region.textContent?.includes("added to your cart"))).toBe(false);
    expect(dialog().querySelector("[aria-current]")).toBeNull();
    expect(link("View cart")).toBeDefined();
    expect(link("Check out")).toBeDefined();
  });

  it("drops the confirmation when the drawer is opened plainly afterwards", async () => {
    await mount();
    await dispatchOpenCart({ addedLineKey: await cartLineKeyFor(shirt) });
    await act(async () => setCartOpen(false));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    await dispatchOpenCart();
    expect(dialog().textContent).not.toContain("Added to your cart");
  });

  it("stays open: nothing closes the drawer on a timer", async () => {
    await mount();
    await dispatchOpenCart({ addedLineKey: await cartLineKeyFor(shirt) });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("returns focus to the control that opened the drawer", async () => {
    const trigger = document.createElement("button");
    trigger.textContent = "Add to cart";
    document.body.append(trigger);
    trigger.focus();
    await mount();
    await dispatchOpenCart({ addedLineKey: await cartLineKeyFor(shirt) });
    expect(dialog().contains(document.activeElement)).toBe(true);

    await act(async () => setCartOpen(false));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
});
