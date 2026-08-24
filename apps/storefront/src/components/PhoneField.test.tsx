// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeCheckoutFormDraft } from "@/lib/checkout/session-state";
import PhoneField from "./PhoneField";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("PhoneField", () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    sessionStorage.clear();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  function enterPhone(input: HTMLInputElement, phone: string) {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(input, phone);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  it("keeps the labeled visible control and canonical form value in one controlled state", async () => {
    await act(async () => {
      root.render(
        <form id="checkout-form">
          <PhoneField name="customerPhone" label="Phone number" required />
        </form>,
      );
    });

    const label = host.querySelector("label");
    const visibleInput =
      host.querySelector<HTMLInputElement>(".PhoneInputInput");
    const canonicalInput = host.querySelector<HTMLInputElement>(
      'input[name="customerPhone"]',
    );

    expect(label?.htmlFor).toBe("customerPhone-input");
    expect(visibleInput?.id).toBe("customerPhone-input");
    expect(visibleInput?.getAttribute("aria-required")).not.toBe("false");
    expect(visibleInput?.name).toBe("");
    expect(canonicalInput?.type).toBe("hidden");
    expect(canonicalInput?.value).toBe("");
  });

  it("claims the saved checkout phone during its first hydrated render", async () => {
    writeCheckoutFormDraft({ customerPhone: "+8801700000000" });

    await act(async () => {
      root.render(
        <form id="checkout-form">
          <PhoneField name="customerPhone" label="Phone number" required />
        </form>,
      );
    });

    const visibleInput =
      host.querySelector<HTMLInputElement>(".PhoneInputInput");
    const canonicalInput = host.querySelector<HTMLInputElement>(
      'input[name="customerPhone"]',
    );

    expect(visibleInput?.value).toContain("17");
    expect(canonicalInput?.value).toBe("+8801700000000");
    expect(canonicalInput?.dataset.e164Value).toBe("+8801700000000");
  });

  it("updates the authoritative visible value after an external prefill", async () => {
    await act(async () => {
      root.render(
        <form id="checkout-form">
          <PhoneField name="customerPhone" label="Phone number" required />
        </form>,
      );
    });

    const visibleInput =
      host.querySelector<HTMLInputElement>(".PhoneInputInput");
    const canonicalInput = host.querySelector<HTMLInputElement>(
      'input[name="customerPhone"]',
    );

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("phone-prefill", { detail: "+8801712345678" }),
      );
    });

    expect(visibleInput?.value).toContain("17");
    expect(canonicalInput?.value).toBe("+8801712345678");
    expect(canonicalInput?.dataset.e164Value).toBe("+8801712345678");
    expect(
      new FormData(host.querySelector<HTMLFormElement>("#checkout-form")!).get(
        "customerPhone",
      ),
    ).toBe("+8801712345678");
  });

  it("lets an explicit empty draft override a signed-in profile default", async () => {
    writeCheckoutFormDraft({ customerPhone: "" });

    await act(async () => {
      root.render(
        <PhoneField
          name="customerPhone"
          defaultValue="+8801712345678"
          label="Phone number"
          required
        />,
      );
    });

    expect(
      host.querySelector<HTMLInputElement>(".PhoneInputInput")?.value,
    ).toBe("+880");
    expect(
      host.querySelector<HTMLInputElement>('input[name="customerPhone"]')
        ?.value,
    ).toBe("");

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("phone-prefill", { detail: "+8801812345678" }),
      );
    });

    expect(
      host.querySelector<HTMLInputElement>(".PhoneInputInput")?.value,
    ).toBe("+880");
  });

  it("invalidates old draft and payment-transfer values on clear, then replaces both on re-entry", async () => {
    writeCheckoutFormDraft({
      customerName: "Buyer",
      customerPhone: "+8801712345678",
    });
    sessionStorage.setItem(
      "scalius_checkout_data",
      JSON.stringify({
        customerName: "Buyer",
        customerPhone: "+8801712345678",
      }),
    );

    await act(async () => {
      root.render(
        <PhoneField name="customerPhone" label="Phone number" required />,
      );
    });

    const visibleInput =
      host.querySelector<HTMLInputElement>(".PhoneInputInput")!;
    const canonicalInput = host.querySelector<HTMLInputElement>(
      'input[name="customerPhone"]',
    )!;

    await act(async () => enterPhone(visibleInput, ""));

    expect(visibleInput.value).toBe("+880");
    expect(canonicalInput.value).toBe("");
    expect(
      JSON.parse(sessionStorage.getItem("scalius_checkout_data") || "{}"),
    ).toMatchObject({ customerName: "Buyer", customerPhone: "" });
    expect(
      JSON.parse(sessionStorage.getItem("scalius_checkout_form_draft") || "{}"),
    ).toMatchObject({ values: { customerName: "Buyer", customerPhone: "" } });

    await act(async () => enterPhone(visibleInput, "+8801812345678"));

    expect(visibleInput.value).toContain("18");
    expect(canonicalInput.value).toBe("+8801812345678");
    expect(
      JSON.parse(sessionStorage.getItem("scalius_checkout_data") || "{}"),
    ).toMatchObject({ customerName: "Buyer", customerPhone: "+8801812345678" });
    expect(
      JSON.parse(sessionStorage.getItem("scalius_checkout_form_draft") || "{}"),
    ).toMatchObject({
      values: { customerName: "Buyer", customerPhone: "+8801812345678" },
    });
  });
});
