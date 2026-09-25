// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ logoutCustomer: vi.fn(async () => undefined) }));
vi.mock("@/lib/api/customer-auth", () => ({ logoutCustomer: api.logoutCustomer }));

import { addToCart, cartStore, CART_STORAGE_KEY, hydrateCartFromStorage } from "@/store/cart";
import { signOutCustomer } from "./customer-sign-out";

const CHECKOUT_KEYS = [
  "scalius_checkout_data",
  "scalius_checkout_gateways",
  "scalius_checkout_payment_method",
  "scalius_checkout_form_draft",
  "checkoutId",
  "scalius_cart_repair_state",
  "scalius_cart_line_edit",
  "quickBuyData",
  "scalius_submitted_cart",
  "scalius_last_order",
];

describe("signing out on a shared device", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    api.logoutCustomer.mockClear();
  });

  it("ends the session, empties the cart and every checkout key, then tells the page", async () => {
    hydrateCartFromStorage();
    await addToCart({ id: "prod_tee", variantId: "var_tee_m", name: "STAB Tee", price: 500, quantity: 2 });
    expect(cartStore.get().totalItems).toBe(2);
    for (const key of CHECKOUT_KEYS) sessionStorage.setItem(key, "{\"customerPhone\":\"01700000000\"}");
    localStorage.setItem("scalius_hosted_payment_recovery", "{}");
    const events: string[] = [];
    const listener = () => events.push(`logout:${cartStore.get().totalItems}`);
    window.addEventListener("customer-logout", listener);

    await signOutCustomer();
    window.removeEventListener("customer-logout", listener);

    expect(api.logoutCustomer).toHaveBeenCalledTimes(1);
    expect(cartStore.get().totalItems).toBe(0);
    expect(JSON.parse(localStorage.getItem(CART_STORAGE_KEY) ?? "{}").items).toEqual({});
    for (const key of CHECKOUT_KEYS) expect(sessionStorage.getItem(key)).toBeNull();
    expect(localStorage.getItem("scalius_hosted_payment_recovery")).toBeNull();
    // Listeners (the cart page's form) run after the storage is already clear.
    expect(events).toEqual(["logout:0"]);
  });
});
