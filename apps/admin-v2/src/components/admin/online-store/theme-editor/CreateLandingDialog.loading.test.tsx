// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { DEFAULT_STOREFRONT_THEME } from "@scalius/shared/storefront-theme";
import { CreateLandingDialog } from "./PagePicker";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const gate = vi.hoisted(() => {
  let release!: () => void;
  return { started: vi.fn(), promise: new Promise<void>((resolve) => { release = resolve; }), release: () => release() };
});
vi.mock("./CreateLandingDialog", async (original) => {
  gate.started();
  await gate.promise;
  return original();
});

it("loads only on first open, stays closed after a pending close, and resets the real form on reopen", async () => {
  const host = document.createElement("div");
  const picker = document.createElement("button");
  picker.setAttribute("data-page-picker", "");
  document.body.append(picker, host);
  const root = createRoot(host);
  const onCreate = vi.fn();
  const onOpenChange = vi.fn();
  const render = async (open: boolean) => act(async () => root.render(
    <CreateLandingDialog open={open} onOpenChange={onOpenChange} theme={structuredClone(DEFAULT_STOREFRONT_THEME)} onCreate={onCreate} />,
  ));
  try {
    await render(false);
    expect(gate.started).not.toHaveBeenCalled();
    picker.focus();
    await render(true);
    expect(document.querySelector('[role="dialog"][aria-busy="true"]')).not.toBeNull();
    expect(document.querySelector("#new-landing-title")).toBeNull();
    await render(false);
    await vi.waitFor(() => expect(document.activeElement).toBe(picker));
    await act(async () => { gate.release(); await gate.promise; });
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    await render(true);
    const title = await vi.waitFor(() => {
      const input = document.querySelector<HTMLInputElement>("#new-landing-title");
      expect(input).not.toBeNull();
      return input!;
    });
    await vi.waitFor(() => expect(document.activeElement).toBe(title));
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(title, "October offer");
      title.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(document.querySelector<HTMLInputElement>("#new-landing-slug")?.value).toBe("october-offer");
    await act(async () => document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(onCreate).toHaveBeenCalledWith("october-offer", "October offer", null);
    await render(false);
    await vi.waitFor(() => expect(document.activeElement).toBe(picker));
    await render(true);
    expect(document.querySelector<HTMLInputElement>("#new-landing-title")?.value).toBe("");
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
    expect(gate.started).toHaveBeenCalledOnce();
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  } finally {
    act(() => root.unmount());
    host.remove();
    picker.remove();
  }
});
