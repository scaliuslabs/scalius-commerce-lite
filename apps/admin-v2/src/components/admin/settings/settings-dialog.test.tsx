// @vitest-environment happy-dom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { useSaveBar } from "../shared/SaveBar";
import { SettingsDialog } from "./SettingsPage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const discard = vi.fn();

function NameField() {
  const [name, setName] = useState("Shop");
  useSaveBar({ dirty: name !== "Shop", save: async () => {}, discard: () => { discard(); setName("Shop"); } });
  return <input id="store-name" value={name} onChange={(event) => setName(event.target.value)} />;
}

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

const dialog = () => document.querySelector<HTMLElement>("[role=dialog]");
const confirm = () => document.querySelector<HTMLElement>("[role=alertdialog]");
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === label)!;
const pressEscape = () =>
  document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

describe("settings dialog", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => {
      root.render(
        <SettingsDialog title="Store name" trigger={<button type="button">Edit name</button>}>
          <NameField />
        </SettingsDialog>,
      );
    });
    act(() => button("Edit name").click());
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  it("asks before Esc or Cancel throw away edits, and keeps them on Continue editing", () => {
    act(() => type(document.querySelector<HTMLInputElement>("#store-name")!, "My shop"));

    act(() => pressEscape());
    expect(dialog()).not.toBeNull();
    expect(confirm()?.textContent).toContain("Discard all unsaved changes?");

    act(() => button("Continue editing").click());
    expect(confirm()).toBeNull();
    expect(document.querySelector<HTMLInputElement>("#store-name")?.value).toBe("My shop");
    expect(discard).not.toHaveBeenCalled();

    act(() => button("Cancel").click());
    expect(confirm()).not.toBeNull();
    act(() => button("Discard changes").click());
    expect(discard).toHaveBeenCalledOnce();
    expect(dialog()).toBeNull();
  });

  it("closes an untouched dialog straight away", () => {
    act(() => pressEscape());
    expect(confirm()).toBeNull();
    expect(dialog()).toBeNull();
  });
});
