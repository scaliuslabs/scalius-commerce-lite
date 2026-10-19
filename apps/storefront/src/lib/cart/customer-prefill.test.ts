// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENGLISH_CHECKOUT_LANGUAGE_DATA } from "@scalius/shared/checkout-language";
import type { AuthState } from "../api/customer-auth";
import { readCheckoutFormDraft, writeCheckoutFormDraft } from "../checkout/session-state";
import { runCartPageScript } from "./cart-page-harness";

// Execute the real cart draft/autofill listeners with a deferred session read.
// Keep the page's submission/payment side effects outside this focused harness.
const SCRIPT_END = "// ── Submit ──";

const customer = {
  name: "Test customer", phone: "+8801712345678", email: "customer@example.test",
  defaultAddress: {
    countryCode: "BD", line1: "House 10, Road 2", city: "city_dhaka", cityName: "Dhaka", zone: "zone_mirpur", zoneName: "Mirpur",
  },
};
const phonePrefill = vi.fn();
const locationPrefill = vi.fn();
let resolveSession: (state: AuthState) => void;
let captureDraft: (captureAllFields?: boolean) => void;

function control(name: string) {
  return document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="${name}"]`)!;
}

function startCart() {
  captureDraft = runCartPageScript(
    {
      initCartFunctionality: () => Promise.resolve(),
      getCustomerSession: () => new Promise<AuthState>((resolve) => { resolveSession = resolve; }),
      fetchDeliveryRates: vi.fn(async () => []),
      browserApiUrl: (path: string) => path,
    },
    { stopBefore: SCRIPT_END, returning: "persistCheckoutFormDraftNow" },
  ) as typeof captureDraft;
}

async function finishSession() {
  // The default address in brief: the prefill reads only these fields.
  resolveSession({ authenticated: true, customer: customer as unknown as NonNullable<AuthState["customer"]> });
  await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(document, "readyState", "get").mockReturnValue("complete");
  sessionStorage.clear();
  document.cookie = "cs_auth=1; path=/";
  window.__CHECKOUT_LANGUAGE__ = { languageData: ENGLISH_CHECKOUT_LANGUAGE_DATA };
  document.body.innerHTML = `<div id="checkout-meta" data-guest-checkout-enabled="true"></div>
    <form id="checkoutForm">
      <input id="customerName" name="customerName" />
      <input id="customerPhone-input" />
      <input type="hidden" name="customerPhone" data-e164-value="" />
      <input id="customerEmail" name="customerEmail" />
      <textarea id="shippingAddress" name="shippingAddress"></textarea>
      <input type="hidden" name="city" /><input type="hidden" name="zone" /><input type="hidden" name="area" />
      <input type="radio" name="shippingLocation" value="standard" checked />
      <textarea name="notes"></textarea>
    </form>`;
  window.addEventListener("phone-prefill", phonePrefill);
  window.addEventListener("location-prefill", locationPrefill);
});

afterEach(() => {
  window.__scaliusCartPageAbortController?.abort();
  delete window.__scaliusCartPageAbortController;
  window.removeEventListener("phone-prefill", phonePrefill);
  window.removeEventListener("location-prefill", locationPrefill);
  document.body.innerHTML = "";
  document.cookie = "cs_auth=; Max-Age=0; path=/";
  sessionStorage.clear();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("customer checkout prefill", () => {
  it.each([
    ["shippingLocationChange", false],
    ["cart-updated", false],
    ["shippingLocationChange", true],
  ] as const)("does not claim untouched blanks after %s (partial fields: %s)", async (eventName, partialFields) => {
    if (partialFields) {
      control("customerName").value = customer.name;
      control("shippingAddress").value = customer.defaultAddress.line1;
    }
    startCart();
    const target = eventName === "cart-updated" ? document : window;
    target.dispatchEvent(new CustomEvent(eventName));
    await vi.advanceTimersByTimeAsync(120);
    const draft = readCheckoutFormDraft();
    expect(draft?.shippingLocation).toBe("standard");
    for (const field of ["customerPhone", "customerEmail", "city", "zone"]) {
      expect(draft).not.toHaveProperty(field);
    }
    await finishSession();
    expect(control("customerName").value).toBe(customer.name);
    expect(control("customerEmail").value).toBe(customer.email);
    expect(control("shippingAddress").value).toBe(customer.defaultAddress.line1);
    expect(phonePrefill).toHaveBeenCalledOnce();
    expect(phonePrefill.mock.calls[0]?.[0].detail).toBe(customer.phone);
    expect(locationPrefill.mock.calls[0]?.[0].detail).toMatchObject({ city: customer.defaultAddress.city, zone: customer.defaultAddress.zone });
  });

  it("preserves buyer clears when the session returns before the draft debounce", async () => {
    startCart();
    for (const name of ["customerName", "customerEmail", "shippingAddress"]) {
      const input = control(name);
      input.value = "";
      const event = new Event("input", { bubbles: true });
      // Model a native buyer input; programmatic hydration must not claim edits.
      Object.defineProperty(event, "isTrusted", { value: true });
      input.dispatchEvent(event);
    }
    expect(readCheckoutFormDraft()).toBeNull();
    await finishSession();
    expect(control("customerName").value).toBe("");
    expect(control("customerEmail").value).toBe("");
    expect(control("shippingAddress").value).toBe("");
    await vi.advanceTimersByTimeAsync(120);
    expect(readCheckoutFormDraft()).toMatchObject({ customerName: "", customerEmail: "", shippingAddress: "" });
  });

  it("keeps explicitly cleared contact and location fields after draft reload", async () => {
    const cleared = { customerName: "", customerPhone: "", customerEmail: "", shippingAddress: "", city: "", zone: "" };
    writeCheckoutFormDraft(cleared);
    startCart();
    window.dispatchEvent(new CustomEvent("shippingLocationChange"));
    await vi.advanceTimersByTimeAsync(120);
    await finishSession();
    expect(readCheckoutFormDraft()).toMatchObject(cleared);
    expect(control("customerName").value).toBe("");
    expect(control("customerEmail").value).toBe("");
    expect(control("shippingAddress").value).toBe("");
    expect(phonePrefill).not.toHaveBeenCalled();
    expect(locationPrefill).not.toHaveBeenCalled();
  });

  it("keeps the canonical phone draft while the phone control is still empty", async () => {
    writeCheckoutFormDraft({ customerPhone: customer.phone });
    startCart();
    document.dispatchEvent(new CustomEvent("cart-updated"));
    await vi.advanceTimersByTimeAsync(120);
    expect(control("customerPhone").value).toBe("");
    expect(readCheckoutFormDraft()?.customerPhone).toBe(customer.phone);
    captureDraft(true);
    expect(readCheckoutFormDraft()?.customerPhone).toBe(customer.phone);
  });

  it("replaces a phone someone typed earlier with the account's phone on sign-in", async () => {
    const phoneInput = document.getElementById("customerPhone-input")!;
    const field = document.createElement("div");
    field.id = "customerPhone-field";
    field.dataset.defaultCountry = "BD";
    phoneInput.replaceWith(field);
    field.append(phoneInput, document.querySelector('input[name="customerPhone"]')!);
    control("customerName").value = "Draft Person";
    startCart();
    const typed = document.getElementById("customerPhone-input") as HTMLInputElement;
    typed.value = "01799200077";
    typed.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(120);
    expect(readCheckoutFormDraft()?.customerPhone).toBe("+8801799200077");

    window.dispatchEvent(new CustomEvent("customer-login", { detail: customer }));

    expect(typed.value).toBe("01712345678");
    expect(control("customerPhone").value).toBe(customer.phone);
    expect(control("customerName").value).toBe(customer.name);
    expect(readCheckoutFormDraft()).toMatchObject({ customerPhone: customer.phone, customerName: customer.name });
  });

  it("captures cleared dependent locations when a different city is selected", async () => {
    writeCheckoutFormDraft({ city: "old_city", zone: "old_zone", area: "old_area" });
    startCart();
    window.dispatchEvent(new CustomEvent("checkout-location-change", { detail: {
      cityId: "new_city", cityName: "New city", zoneId: "", zoneName: "", areaId: "", areaName: "",
    } }));
    await vi.advanceTimersByTimeAsync(120);
    expect(readCheckoutFormDraft()).toMatchObject({ city: "new_city", cityName: "New city", zone: "", area: "" });
    await finishSession();
    expect(locationPrefill).not.toHaveBeenCalled();
  });

  it("captures all current fields at submission and synchronizes existing payment transfer", () => {
    writeCheckoutFormDraft({ customerName: "Previous name", shippingAddress: "Previous address" });
    sessionStorage.setItem("scalius_checkout_data", JSON.stringify({ customerName: "Previous name", shippingAddress: "Previous address", checkoutId: "checkout_test" }));
    startCart();
    control("customerName").value = "";
    control("shippingAddress").value = "";
    captureDraft(true);
    expect(readCheckoutFormDraft()).toMatchObject({ customerName: "", shippingAddress: "", customerEmail: "", city: "", zone: "", shippingLocation: "standard" });
    // The transfer keeps the address as submit writes it: an empty one is no address.
    const transfer = JSON.parse(sessionStorage.getItem("scalius_checkout_data")!);
    expect(transfer).toMatchObject({ customerName: "", checkoutId: "checkout_test" });
    expect(transfer).not.toHaveProperty("shippingAddress");
  });
});
