// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { init } from "./product-controller";
import { startBuyNow } from "@/store/cart";

vi.mock("@/store/cart", () => ({
  addToCart: vi.fn(), startBuyNow: vi.fn(), replaceCartLine: vi.fn(), cartLineKeyFor: vi.fn(),
}));
vi.mock("../lib/product-analytics", () => ({
  trackProductAddToCart: vi.fn(), extractProductDataFromDOM: () => null, convertVariantToAnalyticsData: vi.fn(),
}));

const buy = () => document.querySelector<HTMLButtonElement>('[data-action="buy-now"]')!;
function mount(available = true) {
  const variants = [{ id: "tee_m", selectedOptions: [], price: 100, stock: available ? 1 : 0,
    reservedStock: 0, trackInventory: true, availabilityBand: available ? "in_stock" : "out_of_stock" }];
  document.body.innerHTML = `
    <div id="product-container" data-product-id="tee" data-product-name="Tee" data-product-slug="tee"
      data-product-original-price="100" data-currency-decimal-places="2"></div>
    <script type="application/json" id="product-options-data">[]</script>
    <script type="application/json" id="product-variants-data">${JSON.stringify(variants)}</script>
    <form id="buy-form" data-product-buy-form><input type="hidden" name="variant" value="tee_m"></form>
    <input id="quantity" value="1" form="buy-form">
    <div id="product-actions" data-buy-now-text="Buy now" data-add-to-cart-text="Add to cart" data-unavailable-text="Sold out"
      data-quantity-limit-text="একবারে সর্বোচ্চ {count}টি কেনা যাবে।"
      data-cart-add-failed-text="পণ্যটি যোগ করা যায়নি। কার্ট ও ব্রাউজারের সাইট স্টোরেজ দেখে আবার যোগ করুন।">
      <button type="submit" form="buy-form" data-action="add-to-cart">Add to cart</button>
      <button type="submit" form="buy-form" data-action="buy-now">Buy now</button>
    </div>`;
  init();
}

beforeEach(() => {
  vi.mocked(startBuyNow).mockReset();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => callback(0));
});
afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); });

describe("product Buy now", () => {
  it("adds once during rapid clicks and form submission, then waits for persistence before navigation", async () => {
    let finish!: (value: boolean) => void;
    vi.mocked(startBuyNow).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    mount();
    const before = window.location.href;
    buy().click();
    buy().click();
    document.querySelector("form")!.dispatchEvent(new SubmitEvent("submit", { cancelable: true, submitter: buy() }));
    expect(startBuyNow).toHaveBeenCalledTimes(1);
    expect(window.location.href).toBe(before);
    expect(buy().getAttribute("aria-busy")).toBe("true");
    finish(true);
    await vi.waitFor(() => expect(window.location.pathname).toBe("/cart"));
  });

  it.each([
    ["quantity_limit", "একবারে সর্বোচ্চ 99টি কেনা যাবে।"],
    ["storage_unavailable", "পণ্যটি যোগ করা যায়নি। কার্ট ও ব্রাউজারের সাইট স্টোরেজ দেখে আবার যোগ করুন।"],
  ] as const)("shows the localized %s failure and stays on the page", async (reason, message) => {
    vi.mocked(startBuyNow).mockImplementation(async (_item, options) => {
      options?.onFailure?.(reason);
      return false;
    });
    mount();
    const before = window.location.href;
    buy().click();
    await vi.waitFor(() => expect(document.querySelector("[data-product-action-error]")?.getAttribute("role")).toBe("alert"));
    expect(window.location.href).toBe(before);
    expect(document.querySelector("[data-product-action-error]")?.textContent).toBe(message);
    expect(startBuyNow).toHaveBeenCalledTimes(1);
  });

  it("refuses a sold-out SKU even when the form is submitted directly", async () => {
    mount(false);
    document.querySelector("form")!.dispatchEvent(new SubmitEvent("submit", { cancelable: true, submitter: buy() }));
    expect(startBuyNow).not.toHaveBeenCalled();
    expect(buy().disabled).toBe(true);
    expect(document.querySelector("[data-product-action-error]")?.textContent).toMatch(/out of stock/);
  });
});
