// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateStorefrontPhone } from "@/lib/phone-country-policy";
import { readCheckoutFormDraft, writeCheckoutFormDraft } from "./session-state";
import {
  checkoutPhoneResult,
  initCheckoutPhoneField,
  loadCheckoutPhoneValidator,
  normalizePhonePolicy,
  quickValidatePhone,
} from "./phone-field";

const ANY_COUNTRY = normalizePhonePolicy(undefined);
let controller: AbortController;

function render(attributes = 'data-default-country="BD"') {
  document.body.innerHTML = `<form id="checkoutForm">
    <div id="customerPhone-field" ${attributes} data-invalid-message="Invalid" data-required-message="Required" data-country-message="Not accepted">
      <input type="hidden" name="customerPhone" value="" data-e164-value="" />
      <div data-phone-box><input id="customerPhone-input" /></div>
      <p id="customerPhone-error" class="hidden"></p>
    </div>
  </form>`;
  initCheckoutPhoneField(controller.signal);
  return {
    input: document.getElementById("customerPhone-input") as HTMLInputElement,
    canonical: document.querySelector<HTMLInputElement>('input[name="customerPhone"]')!,
    error: document.getElementById("customerPhone-error")!,
  };
}

function type(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function submittedPhone() {
  return new FormData(document.getElementById("checkoutForm") as HTMLFormElement).get("customerPhone");
}

beforeEach(() => {
  sessionStorage.clear();
  controller = new AbortController();
});

afterEach(() => {
  controller.abort();
  document.body.innerHTML = "";
  sessionStorage.clear();
});

describe("Bangladesh mobile fast path", () => {
  it.each([
    "01712345678",
    "017 1234-5678",
    "+8801712345678",
    "+88 01712345678",
    "8801712345678",
    "1712345678",
  ])("canonicalizes %s", (spelling) => {
    expect(quickValidatePhone(spelling, ANY_COUNTRY, "BD")).toEqual({
      ok: true,
      value: "+8801712345678",
    });
  });

  it("accepts only numbers the server-side libphonenumber validation accepts, with the same value", () => {
    for (const operator of ["3", "4", "5", "6", "7", "8", "9"]) {
      for (const subscriber of ["00000000", "12345678", "99999999"]) {
        const spelling = `01${operator}${subscriber}`;
        const quick = quickValidatePhone(spelling, ANY_COUNTRY, "BD");
        expect(quick?.ok).toBe(true);
        expect(validateStorefrontPhone(`+880${spelling.slice(1)}`, undefined)).toEqual({
          ok: true,
          value: quick?.value,
        });
      }
    }
  });

  it("defers everything else to the international validator", () => {
    for (const spelling of ["0171234567", "01212345678", "0212345678", "+447911123456"]) {
      expect(quickValidatePhone(spelling, ANY_COUNTRY, "BD")).toBeNull();
    }
    expect(quickValidatePhone("01712345678", ANY_COUNTRY, "IN")).toBeNull();
    expect(quickValidatePhone("  ", ANY_COUNTRY, "BD")).toEqual({
      ok: false,
      value: "",
      message: "required",
    });
  });

  it("rejects a Bangladesh number when the store does not accept Bangladesh", () => {
    const policy = normalizePhonePolicy({ countries: ["bd"], mode: "exclude" });
    expect(quickValidatePhone("+8801712345678", policy, "IN")).toEqual({
      ok: false,
      value: "",
      message: "country",
    });
  });
});

describe("checkout phone field", () => {
  it("submits only the canonical E.164 value and keeps the draft in step", () => {
    sessionStorage.setItem(
      "scalius_checkout_data",
      JSON.stringify({ customerName: "Buyer", customerPhone: "+8801912345678" }),
    );
    const { input, canonical } = render();

    type(input, "017 1234-5678");
    expect(canonical.dataset.e164Value).toBe("+8801712345678");
    expect(submittedPhone()).toBe("+8801712345678");
    expect(readCheckoutFormDraft()?.customerPhone).toBe("+8801712345678");
    expect(JSON.parse(sessionStorage.getItem("scalius_checkout_data")!)).toMatchObject({
      customerName: "Buyer",
      customerPhone: "+8801712345678",
    });

    type(input, "0171");
    expect(submittedPhone()).toBe("");
    expect(readCheckoutFormDraft()?.customerPhone).toBe("");
    expect(checkoutPhoneResult()).toMatchObject({ ok: false, value: "" });
  });

  it("restores a saved phone before any buyer interaction", () => {
    writeCheckoutFormDraft({ customerPhone: "+8801700000000" });
    const { input, canonical } = render();

    expect(input.value).toBe("01700000000");
    expect(canonical.value).toBe("+8801700000000");
    expect(checkoutPhoneResult()).toEqual({ ok: true, value: "+8801700000000" });
  });

  it("keeps a number the buyer typed before the script ran over a saved draft", () => {
    writeCheckoutFormDraft({ customerPhone: "+8801700000000" });
    document.body.innerHTML = `<div id="customerPhone-field" data-default-country="BD">
      <input type="hidden" name="customerPhone" value="" />
      <input id="customerPhone-input" value="01812345678" />
    </div>`;
    initCheckoutPhoneField(controller.signal);

    expect(checkoutPhoneResult()).toEqual({ ok: true, value: "+8801812345678" });
    expect(readCheckoutFormDraft()?.customerPhone).toBe("+8801812345678");
  });

  it("applies an account prefill unless the buyer or a saved draft already owns the phone", () => {
    const { input, canonical } = render();
    window.dispatchEvent(new CustomEvent("phone-prefill", { detail: "+8801712345678" }));
    expect(canonical.value).toBe("+8801712345678");

    type(input, "01912345678");
    window.dispatchEvent(new CustomEvent("phone-prefill", { detail: "+8801812345678" }));
    expect(canonical.value).toBe("+8801912345678");
  });

  it("lets an explicit empty draft override a signed-in profile default", () => {
    writeCheckoutFormDraft({ customerPhone: "" });
    const { input, canonical } = render();

    window.dispatchEvent(new CustomEvent("phone-prefill", { detail: "+8801812345678" }));
    expect(input.value).toBe("");
    expect(canonical.value).toBe("");
  });

  it("keeps a profile phone outside the accepted countries out of the form", async () => {
    const { input, canonical } = render('data-default-country="BD" data-countries="BD" data-country-mode="include"');

    window.dispatchEvent(new CustomEvent("phone-prefill", { detail: "+12025550123" }));
    await loadCheckoutPhoneValidator();
    await Promise.resolve();

    expect(canonical.value).toBe("");
    expect(input.value).toBe("");
    expect(submittedPhone()).toBe("");
  });

  it("validates international numbers once the lazy validator loads", async () => {
    const { input, canonical } = render();

    type(input, "+44 7911 123456");
    await loadCheckoutPhoneValidator();
    expect(checkoutPhoneResult()).toEqual({ ok: true, value: "+447911123456" });
    type(input, "+44 7911 123456");
    expect(canonical.value).toBe("+447911123456");
  });

  it("reports the store country policy through the lazy validator", async () => {
    const { input } = render('data-default-country="BD" data-countries="BD" data-country-mode="include"');

    type(input, "+447911123456");
    await loadCheckoutPhoneValidator();
    expect(checkoutPhoneResult()).toEqual({ ok: false, value: "", message: "country" });
  });

  it("shows an inline error on blur and on a submit validation error", async () => {
    const { input, error } = render();

    type(input, "0171234");
    input.dispatchEvent(new FocusEvent("blur"));
    await loadCheckoutPhoneValidator();
    await Promise.resolve();
    expect(error.textContent).toBe("Invalid");
    expect(input.getAttribute("aria-invalid")).toBe("true");

    type(input, "01712345678");
    expect(error.classList.contains("hidden")).toBe(true);
    expect(input.hasAttribute("aria-invalid")).toBe(false);

    window.dispatchEvent(new CustomEvent("phone-validation-error", {
      detail: { name: "customerPhone", message: "Required" },
    }));
    expect(error.textContent).toBe("Required");
  });
});
