// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/cart/browser-api", () => ({
  previewCartDiscounts: vi.fn(async () => ({ ok: false, message: null })),
}));

import CartFlyout, { setCartOpen } from "./CartFlyout";
import { addToCart, clearCart } from "@/store/cart";
import { renderBuyerUi } from "@/lib/buyer-ui";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;

const drawerBlock = {
  appId: "acme.notes", releaseId: "release123", target: "cart_drawer.footer",
  ui: { type: "text", text: "Free gift wrap on this order" }, attributes: [], values: {},
};

function answer(buyerUi: unknown[]) {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ success: true, data: { issues: [], ruleErrors: [], buyerUi } }), { status: 200 }));
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  localStorage.clear();
  sessionStorage.clear();
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
  await addToCart({ id: "tea", slug: "tea", name: "Tea", price: 500, variantId: "var_tea", quantity: 1 });
  await act(async () => root.render(<CartFlyout />));
  await act(async () => {
    document.dispatchEvent(new CustomEvent("open-cart"));
    await vi.advanceTimersByTimeAsync(500);
  });
}

const mount = () => document.querySelector<HTMLElement>('[data-buyer-ui-target="cart_drawer.footer"]')!;

describe("cart drawer buyer UI", () => {
  it("draws the apps' footer blocks from its own cart check, above Check out", async () => {
    sessionStorage.setItem("scalius:buyer-attributes", JSON.stringify({ "acme.notes.note": "Hello" }));
    const fetchMock = answer([drawerBlock, { ...drawerBlock, target: "cart.page.below", ui: { type: "text", text: "Page only" } }]);
    vi.stubGlobal("fetch", fetchMock);
    await openDrawer();
    await vi.waitFor(() => expect(mount().textContent).toBe("Free gift wrap on this order"));
    expect(mount().hidden).toBe(false);
    expect(document.body.textContent).not.toContain("Page only");
    // Above the checkout action, in the footer.
    const checkout = [...document.querySelectorAll("a")].find((link) => link.textContent?.includes("Check out"))!;
    expect(mount().compareDocumentPosition(checkout) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The one check it already made: answers in the body, the page's language in headers, nothing in the URL.
    const validations = fetchMock.mock.calls.filter(([url]) => String(url) === "/api/checkout/validate-cart");
    expect(validations).toHaveLength(1);
    const init = validations[0]![1]!;
    expect(JSON.parse(String(init.body)).attributes).toEqual({ "acme.notes.note": "Hello" });
    expect(init.headers).toMatchObject({ "x-storefront-language": expect.any(String) });
    // The cart page's own render (document-wide) does not clear the drawer.
    renderBuyerUi([]);
    expect(mount().textContent).toBe("Free gift wrap on this order");
  });

  it("keeps the mount hidden and empty without a block", async () => {
    vi.stubGlobal("fetch", answer([]));
    await openDrawer();
    expect(mount()).not.toBeNull();
    expect(mount().hidden).toBe(true);
    expect(mount().childElementCount).toBe(0);
  });
});
