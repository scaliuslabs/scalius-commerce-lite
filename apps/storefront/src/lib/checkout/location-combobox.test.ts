// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { enhanceLocationCombobox } from "./location-combobox";

function render() {
  document.body.innerHTML = `<form>
    <label for="checkout-zone">Thana</label>
    <select id="checkout-zone" name="zone" required aria-describedby="err">
      <option value="">Select a thana</option>
      <option value="z_demra">Demra</option>
      <option value="z_kamrangirchar">Kamrangirchar</option>
      <option value="z_mirpur">Mirpur</option>
      <option value="z_mirpur10">Mirpur-10</option>
      <option value="z_gulshan">Gulshan</option>
    </select>
    <p id="err"></p>
  </form>`;
  const select = document.querySelector<HTMLSelectElement>("select")!;
  const changes = vi.fn();
  select.addEventListener("change", () => changes(select.value));
  const box = enhanceLocationCombobox(select, { noMatchText: "No match for “{query}”", closeText: "Close" });
  const input = document.getElementById("checkout-zone") as HTMLInputElement;
  return { select, input, box, changes };
}

const listed = () => Array.from(document.querySelectorAll("[role=option]")).map((item) => item.textContent?.replace("✓", ""));
const key = (target: HTMLElement, key: string) =>
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
const type = (input: HTMLInputElement, text: string) => {
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
};

afterEach(() => {
  document.body.innerHTML = "";
});

describe("location combobox", () => {
  it("takes over the select's label, description and required state; the select still submits", () => {
    const { select, input } = render();
    expect(input.getAttribute("role")).toBe("combobox");
    expect(input.getAttribute("aria-expanded")).toBe("false");
    expect(input.getAttribute("aria-describedby")).toBe("err");
    expect(input.getAttribute("aria-required")).toBe("true");
    expect(input.placeholder).toBe("Select a thana");
    expect(select.hidden).toBe(true);
    expect(select.required).toBe(false);
    expect(select.name).toBe("zone");
    expect(document.querySelector("[role=listbox]")?.getAttribute("aria-labelledby")).toBe(
      document.querySelector("label")!.id,
    );
  });

  it("just select: a click opens the whole list and a click on a place chooses it and closes", () => {
    const { select, input, changes } = render();
    input.click();
    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(listed()).toEqual(["Demra", "Kamrangirchar", "Mirpur", "Mirpur-10", "Gulshan"]);
    (document.querySelectorAll("[role=option]")[4] as HTMLElement).click();
    expect(select.value).toBe("z_gulshan");
    expect(input.value).toBe("Gulshan");
    expect(input.getAttribute("aria-expanded")).toBe("false");
    expect(changes).toHaveBeenCalledTimes(1);
  });

  it("search then select: typing filters best match first, in English or Bangla, and Enter chooses it", () => {
    const { select, input, changes } = render();
    type(input, "mir");
    expect(listed()).toEqual(["Mirpur", "Mirpur-10"]);
    expect(input.getAttribute("aria-activedescendant")).toBe("checkout-zone-list-0");
    type(input, "গুলশান");
    expect(listed()).toEqual(["Gulshan"]);
    key(input, "Enter");
    expect(select.value).toBe("z_gulshan");
    expect(changes).toHaveBeenCalledWith("z_gulshan");
  });

  it("moves with the arrow keys, closes on Escape keeping the chosen place, and says when nothing matches", () => {
    const { select, input, changes } = render();
    key(input, "ArrowDown");
    expect(input.getAttribute("aria-expanded")).toBe("true");
    key(input, "ArrowDown");
    key(input, "ArrowDown");
    key(input, "ArrowDown");
    key(input, "ArrowUp");
    const active = document.getElementById(input.getAttribute("aria-activedescendant")!)!;
    expect(active.getAttribute("role")).toBe("option");
    expect(active.classList.contains("bg-muted")).toBe(true);
    const chosen = active.textContent!;
    key(input, "Enter");
    expect(select.options[select.selectedIndex]!.text).toBe(chosen);
    expect(input.value).toBe(chosen);
    type(input, "zzz");
    expect(listed()).toEqual([]);
    expect(document.querySelector("[role=status]")?.textContent).toBe("No match for “zzz”");
    key(input, "Escape");
    expect(input.getAttribute("aria-expanded")).toBe("false");
    expect(input.value).toBe(chosen);
    expect(changes).toHaveBeenCalledTimes(1);
  });

  it("follows the select: loading, disabled and new options", () => {
    const { select, input, box } = render();
    const loading = document.createElement("option");
    loading.value = "";
    loading.textContent = "Loading…";
    select.replaceChildren(loading);
    select.disabled = true;
    select.setAttribute("aria-busy", "true");
    box.sync();
    // A loading list can still take focus: choosing a city moves on to it.
    expect(input.disabled).toBe(false);
    expect(input.placeholder).toBe("Loading…");
    select.removeAttribute("aria-busy");
    box.sync();
    expect(input.disabled).toBe(true);
  });

  it("takes a browser-autofilled name when it names one place", () => {
    const { select, input } = render();
    input.value = "mirpur-10";
    input.dispatchEvent(new Event("change", { bubbles: true }));
    expect(select.value).toBe("z_mirpur10");
    expect(input.value).toBe("Mirpur-10");
  });
});
