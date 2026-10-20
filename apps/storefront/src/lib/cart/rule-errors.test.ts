// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import {
  BANGLA_CHECKOUT_LANGUAGE_DATA,
  ENGLISH_CHECKOUT_LANGUAGE_DATA,
} from "@scalius/shared/checkout-language";

import type { CartRuleError } from "../api/orders";
import type { CartItem } from "../../store/cart";
import { applyCheckoutButtonState } from "./checkout-button-state";
import {
  CHECKOUT_CART_REPAIR_STORAGE_KEY,
  readAndClearCartRepairState,
  writeCartRepairState,
} from "./repair-state";
import {
  cartLineRuleErrorsId,
  fillCartRuleBanner,
  groupCartRuleErrors,
  mergeCartRuleErrors,
  renderCartLineRuleErrors,
} from "./rule-errors";

const ITEMS = {
  line_1: { id: "prod_1", name: "Rice", price: 100, quantity: 12, variantId: "var_1" },
  line_2: { id: "prod_2", name: "Oil", price: 200, quantity: 1, variantId: "var_2" },
} as unknown as Record<string, CartItem>;

const MALICIOUS = '<img src=x onerror="window.__rulePwned=true">At most 10';

const lineRule: CartRuleError = { code: "max_qty", message: "At most 10 per order.", index: 0, cartKey: "line_1" };
const cartRule: CartRuleError = { code: "min_total", message: "Spend ৳500 to check out.", index: null, cartKey: null };

afterEach(() => {
  document.body.innerHTML = "";
  delete (window as typeof window & { __rulePwned?: boolean }).__rulePwned;
});

describe("store app rules on the cart page", () => {
  it("puts a rule on its line by its cart key, and the rest on the cart", () => {
    const stale: CartRuleError = { code: "gone", message: "A removed line.", index: 5, cartKey: "line_gone" };
    expect(groupCartRuleErrors([lineRule, cartRule, stale], ITEMS)).toEqual({
      lines: { line_1: [lineRule] },
      // A line no longer in the cart is never dropped silently: it still blocks.
      cart: [cartRule, stale],
    });
    // Position alone never picks a line.
    expect(groupCartRuleErrors([{ ...lineRule, cartKey: null }], ITEMS).lines).toEqual({});
  });

  it("says each rule once across the availability check and the quote", () => {
    expect(mergeCartRuleErrors([lineRule, cartRule], [{ ...lineRule }], [])).toEqual([lineRule, cartRule]);
  });

  it("renders a line's rules as text, with the id its controls name", () => {
    const id = cartLineRuleErrorsId(0);
    document.body.innerHTML = renderCartLineRuleErrors([{ ...lineRule, message: MALICIOUS }], id);
    const list = document.getElementById(id)!;
    expect(list.hasAttribute("data-cart-line-rule-errors")).toBe(true);
    expect(list.querySelector("img")).toBeNull();
    expect(list.textContent).toBe(MALICIOUS);
    expect(renderCartLineRuleErrors([], id)).toBe("");
  });

  it("fills the banner above the checkout action with the cart's rules and a pointer to the lines", () => {
    document.body.innerHTML = `<div id="cartRuleErrors" class="hidden" role="alert" tabindex="-1"></div>`;
    const banner = document.getElementById("cartRuleErrors")!;

    expect(fillCartRuleBanner(banner, groupCartRuleErrors([{ ...cartRule, message: MALICIOUS }, lineRule], ITEMS), ENGLISH_CHECKOUT_LANGUAGE_DATA)).toBe(true);
    expect(banner.classList.contains("hidden")).toBe(false);
    expect(banner.getAttribute("role")).toBe("alert");
    expect(banner.querySelector("img")).toBeNull();
    expect([...banner.querySelectorAll("p, li")].map((node) => node.textContent)).toEqual([
      "This order can't be placed yet.",
      MALICIOUS,
      ENGLISH_CHECKOUT_LANGUAGE_DATA.reviewCartItemsText,
    ]);
    expect((window as typeof window & { __rulePwned?: boolean }).__rulePwned).toBeUndefined();

    // The chrome follows the checkout language; the app's words are never translated.
    fillCartRuleBanner(banner, groupCartRuleErrors([cartRule], ITEMS), BANGLA_CHECKOUT_LANGUAGE_DATA);
    expect(banner.textContent).toContain(BANGLA_CHECKOUT_LANGUAGE_DATA.cartRulesBlockedText);
    expect(banner.textContent).toContain("Spend ৳500 to check out.");

    expect(fillCartRuleBanner(banner, { lines: {}, cart: [] }, ENGLISH_CHECKOUT_LANGUAGE_DATA)).toBe(false);
    expect(banner.classList.contains("hidden")).toBe(true);
    expect(banner.textContent).toBe("");
  });

  it("blocks the checkout action while a rule holds", () => {
    const button = document.createElement("button");
    const reason = document.createElement("p");
    reason.id = "submitButtonReason";
    applyCheckoutButtonState(button, {
      checkoutUnavailable: false,
      unavailableMessage: "",
      isEmpty: false,
      emptyMessage: ENGLISH_CHECKOUT_LANGUAGE_DATA.cartEmptyErrorText,
      cartRulesBlocked: true,
      cartRulesBlockedMessage: ENGLISH_CHECKOUT_LANGUAGE_DATA.cartRulesBlockedText,
      reasonElement: reason,
    });
    expect(button.disabled).toBe(true);
    expect(reason.textContent).toBe("This order can't be placed yet.");
    expect(button.getAttribute("aria-describedby")).toBe("submitButtonReason");

    applyCheckoutButtonState(button, {
      checkoutUnavailable: false,
      unavailableMessage: "",
      isEmpty: false,
      emptyMessage: ENGLISH_CHECKOUT_LANGUAGE_DATA.cartEmptyErrorText,
      cartRulesBlocked: false,
      reasonElement: reason,
    });
    expect(button.disabled).toBe(false);
    expect(reason.hidden).toBe(true);
  });

  it("hands the checkout's rules to the cart in session storage, bounded on the way back", () => {
    const storage = new Map<string, string>();
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
    });
    writeCartRepairState({ source: "checkout", message: "Blocked", issues: [], ruleErrors: [lineRule] });
    expect(storage.get(CHECKOUT_CART_REPAIR_STORAGE_KEY)).toContain("At most 10 per order.");
    expect(readAndClearCartRepairState()).toMatchObject({ issues: [], ruleErrors: [lineRule] });

    // An older handoff without rules reads as before.
    writeCartRepairState({ source: "checkout", message: "Changed", issues: [] });
    expect(readAndClearCartRepairState()).not.toHaveProperty("ruleErrors");
  });
});
