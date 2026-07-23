// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import CustomDropdown from "./CustomDropdown";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("CustomDropdown", () => {
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

  it("combines the field label and selected value in its accessible name", async () => {
    await act(async () => {
      root.render(
        <>
          <label id="city-label" htmlFor="city">City</label>
          <CustomDropdown
            id="city"
            labelId="city-label"
            name="city"
            placeholder="Select a city"
            options={[{ value: "dhaka", label: "Dhaka" }]}
            value="dhaka"
            onChange={vi.fn()}
          />
        </>,
      );
    });

    const trigger = host.querySelector<HTMLButtonElement>("#city");
    const labelledBy = trigger?.getAttribute("aria-labelledby")?.split(" ") ?? [];

    expect(labelledBy[0]).toBe("city-label");
    expect(labelledBy).toHaveLength(2);
    expect(document.getElementById(labelledBy[1] || "")?.textContent).toBe(
      "Dhaka",
    );
  });
});
