// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";

import { readNamedFormControlValue } from "./form-controls";
import {
  readCheckoutFormDraft,
  writeCheckoutFormDraft,
} from "./session-state";

afterEach(() => {
  document.body.innerHTML = "";
  sessionStorage.clear();
});

describe("readNamedFormControlValue", () => {
  it("reads the checked value from a native radio group", () => {
    document.body.innerHTML = `
      <form id="checkoutForm">
        <input type="radio" name="shippingLocation" value="standard" />
        <input type="radio" name="shippingLocation" value="express" checked />
      </form>
    `;

    expect(
      readNamedFormControlValue(document, "shippingLocation"),
    ).toBe("express");
  });

  it("captures a non-first selected delivery method into checkout draft state", () => {
    document.body.innerHTML = `
      <input type="radio" name="shippingLocation" value="standard" />
      <input type="radio" name="shippingLocation" value="express" checked />
    `;

    const shippingLocation = readNamedFormControlValue(
      document,
      "shippingLocation",
    );
    writeCheckoutFormDraft({ shippingLocation });

    expect(readCheckoutFormDraft()?.shippingLocation).toBe("express");
  });

  it("returns undefined when a native radio group has no checked option", () => {
    document.body.innerHTML = `
      <input type="radio" name="shippingLocation" value="standard" />
      <input type="radio" name="shippingLocation" value="express" />
    `;

    expect(
      readNamedFormControlValue(document, "shippingLocation"),
    ).toBeUndefined();
  });

  it("reads single hidden inputs and text fields without changing their semantics", () => {
    document.body.innerHTML = `
      <input type="hidden" name="shippingLocation" value="standard" />
      <textarea name="notes">Call on arrival</textarea>
    `;

    expect(
      readNamedFormControlValue(document, "shippingLocation"),
    ).toBe("standard");
    expect(readNamedFormControlValue(document, "notes")).toBe(
      "Call on arrival",
    );
  });
});
