// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import landingLink from "./landing-link";

let cleanup: void | (() => void);
afterEach(() => {
  cleanup?.();
  document.body.replaceChildren();
});

const order = (id: string, product: string, ready = true) => `<section class="noor-s-order" id="${id}">
  <div class="noor-order" data-noor-order-product="${product}">${ready ? '<form data-order-form></form>' : '<a href="/products/unavailable">View product</a>'}</div>
</section>`;

function mount(link: string, orders = "", productId?: string) {
  document.body.innerHTML = `<scalius-island>${link}</scalius-island>${orders}`;
  const element = document.querySelector<HTMLElement>("scalius-island")!;
  cleanup = landingLink.mount(element, { productId }, {} as never);
  return element.querySelector<HTMLAnchorElement>("a")!;
}

describe("campaign order links", () => {
  it("keeps the real product link when the merchant has no order section", () => {
    const link = mount('<a href="/products/shirt" data-noor-order-link>Order now</a>', "", "shirt");
    expect(link.getAttribute("href")).toBe("/products/shirt");
    expect(link.hidden).toBe(false);
  });

  it("matches the hero's product instead of ordering a different product", () => {
    const link = mount('<a href="/products/shirt" data-noor-order-link>Order now</a>', order("trousers", "trousers") + order("shirt", "shirt"), "shirt");
    expect(link.getAttribute("href")).toBe("#shirt");
  });

  it("does not offer an order button when core cannot provide the form", () => {
    const link = mount('<a data-noor-order-link hidden>Order now</a>', order("order-shirt", "shirt", false));
    expect(link.hidden).toBe(true);
    expect(link.hasAttribute("href")).toBe(false);
  });

  it("only reveals a generic feature button when a usable form exists", () => {
    const link = mount('<a data-noor-order-link hidden>Order now</a>', order("order-shirt", "shirt"));
    expect(link.hidden).toBe(false);
    expect(link.getAttribute("href")).toBe("#order-shirt");
  });

  it("keeps Shop as the campaign header's fallback and upgrades only for a form", () => {
    const link = mount('<a href="/bn/search" data-noor-order-link data-order-label="অর্ডার করুন">কেনাকাটা করুন</a>');
    expect(link.textContent).toBe("কেনাকাটা করুন");
    document.body.insertAdjacentHTML("beforeend", order("order-shirt", "shirt"));
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(link.textContent).toBe("অর্ডার করুন");
    expect(link.getAttribute("href")).toBe("#order-shirt");
    document.getElementById("order-shirt")!.remove();
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(link.textContent).toBe("কেনাকাটা করুন");
    expect(link.getAttribute("href")).toBe("/bn/search");
  });

  it("cancels an obsolete feature anchor if its form was removed", () => {
    const link = mount('<a data-noor-order-link hidden>Order now</a>', order("order-shirt", "shirt"));
    document.getElementById("order-shirt")!.remove();
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(link.hidden).toBe(true);
    expect(link.hasAttribute("href")).toBe(false);
  });
});
