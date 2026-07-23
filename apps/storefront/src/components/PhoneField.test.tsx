// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import PhoneField from "./PhoneField";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("PhoneField", () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  it("labels the visible phone control while retaining the authoritative hidden value", async () => {
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
    const hiddenInput = host.querySelector<HTMLInputElement>(
      'input[type="hidden"]',
    );

    expect(label?.htmlFor).toBe("customerPhone-input");
    expect(visibleInput?.id).toBe("customerPhone-input");
    expect(visibleInput?.getAttribute("aria-required")).not.toBe("false");
    expect(hiddenInput?.id).toBe("customerPhone");
    expect(hiddenInput?.name).toBe("customerPhone");
  });
});
