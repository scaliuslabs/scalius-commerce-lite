// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeCheckoutFormDraft } from "@/lib/checkout/session-state";
import PhoneField from "./PhoneField";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

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

  it("makes the labeled visible phone control the authoritative form value", async () => {
    await act(async () => {
      root.render(
        <PhoneField
          name="customerPhone"
          label="Phone number"
          required
        />,
      );
    });

    const label = host.querySelector("label");
    const visibleInput = host.querySelector<HTMLInputElement>(
      ".PhoneInputInput",
    );

    expect(label?.htmlFor).toBe("customerPhone-input");
    expect(visibleInput?.id).toBe("customerPhone-input");
    expect(visibleInput?.name).toBe("customerPhone");
    expect(visibleInput?.getAttribute("aria-required")).not.toBe("false");
    expect(host.querySelector('input[type="hidden"]')).toBeNull();
  });

  it("claims the saved checkout phone during its first hydrated render", async () => {
    writeCheckoutFormDraft({ customerPhone: "+8801700000000" });

    await act(async () => {
      root.render(
        <PhoneField
          name="customerPhone"
          label="Phone number"
          required
        />,
      );
    });

    const visibleInput = host.querySelector<HTMLInputElement>(
      ".PhoneInputInput",
    );

    expect(visibleInput?.value).toContain("17");
    expect(visibleInput?.name).toBe("customerPhone");
    expect(visibleInput?.dataset.e164Value).toBe("+8801700000000");
  });

  it("updates the authoritative visible value after an external prefill", async () => {
    await act(async () => {
      root.render(
        <PhoneField
          name="customerPhone"
          label="Phone number"
          required
        />,
      );
    });

    const visibleInput = host.querySelector<HTMLInputElement>(
      ".PhoneInputInput",
    );

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("phone-prefill", { detail: "+8801712345678" }),
      );
    });

    expect(visibleInput?.value).toContain("17");
    expect(visibleInput?.name).toBe("customerPhone");
    expect(visibleInput?.dataset.e164Value).toBe("+8801712345678");
  });
});
