// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENGLISH_CHECKOUT_LANGUAGE_DATA } from "@scalius/shared/checkout-language";
import type { AuthState } from "../api/customer-auth";
import { findNamedCheckoutControl } from "../checkout/form-controls";
import { readCheckoutFormDraft, syncCheckoutTransferSession, writeCheckoutFormDraft } from "../checkout/session-state";
import { getEffectiveCartShippingFee } from "../../store/cart";
import { storefrontSourcePath } from "../test-source-paths";

// Execute the real cart draft/autofill listeners with a deferred session read.
// Keep the page's submission/payment side effects outside this focused harness.
const cartSource = readFileSync(storefrontSourcePath("pages", "cart.astro"), "utf8");
const scriptSource = cartSource.split("<script>")[1]!.split("// ── Multi-gateway checkout redirect")[0]!;
const parsedScript = ts.createSourceFile("cart.ts", scriptSource, ts.ScriptTarget.ES2022, true);
const script = ts.transpileModule(
  parsedScript.statements.filter((statement) => !ts.isImportDeclaration(statement))
    .map((statement) => statement.getFullText(parsedScript)).join("\n"),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } },
).outputText;

const customer = {
  name: "Test customer", phone: "+8801712345678", email: "customer@example.test",
  address: "House 10, Road 2", city: "city_dhaka", cityName: "Dhaka", zone: "zone_mirpur", zoneName: "Mirpur",
};
const phonePrefill = vi.fn();
const locationPrefill = vi.fn();
let resolveSession: (state: AuthState) => void;
let captureDraft: (captureAllFields?: boolean) => void;

function control(name: string) {
  return document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="${name}"]`)!;
}

function startCart() {
  const dependencies = {
    initCartFunctionality: () => Promise.resolve(),
    getCustomerSession: () => new Promise<AuthState>((resolve) => { resolveSession = resolve; }),
    getEffectiveCartShippingFee,
    readCheckoutFormDraft,
    writeCheckoutFormDraft,
    syncCheckoutTransferSession,
    findNamedCheckoutControl,
    ENGLISH_CHECKOUT_LANGUAGE_DATA,
  };
  captureDraft = new Function(...Object.keys(dependencies), `${script}\nreturn persistCheckoutFormDraftNow;`)(...Object.values(dependencies));
}

async function finishSession() {
  resolveSession({ authenticated: true, customer });
  await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(document, "readyState", "get").mockReturnValue("complete");
  sessionStorage.clear();
  document.cookie = "cs_auth=1; path=/";
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
      control("shippingAddress").value = customer.address;
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
    expect(control("shippingAddress").value).toBe(customer.address);
    expect(phonePrefill).toHaveBeenCalledOnce();
    expect(phonePrefill.mock.calls[0]?.[0].detail).toBe(customer.phone);
    expect(locationPrefill.mock.calls[0]?.[0].detail).toMatchObject({ city: customer.city, zone: customer.zone });
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

  it("preserves the canonical phone draft until PhoneField finishes hydration", async () => {
    writeCheckoutFormDraft({ customerPhone: customer.phone });
    startCart();
    document.dispatchEvent(new CustomEvent("cart-updated"));
    await vi.advanceTimersByTimeAsync(120);
    expect(control("customerPhone").value).toBe("");
    expect(readCheckoutFormDraft()?.customerPhone).toBe(customer.phone);
    captureDraft(true);
    expect(readCheckoutFormDraft()?.customerPhone).toBe(customer.phone);
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
    expect(JSON.parse(sessionStorage.getItem("scalius_checkout_data")!)).toMatchObject({ customerName: "", shippingAddress: "", checkoutId: "checkout_test" });
  });
});
