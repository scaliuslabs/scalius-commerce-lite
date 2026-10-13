// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PRODUCT_CONTENT_BLOCK_TYPES, productContentBlockDefault } from "@scalius/shared/product-content-blocks";
import { BlockSettingsEditor } from "./block-editors";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("~/components/ui/tiptap/DeferredTiptapEditor", () => ({
  DeferredTiptapEditor: () => <div contentEditable data-editor="true" />,
}));
vi.mock("~/components/admin/media-manager", () => ({
  MediaManager: () => <button type="button">Choose file</button>,
}));

describe("saved content-block settings", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it.each(PRODUCT_CONTENT_BLOCK_TYPES)("renders %s without mutation controls", (type) => {
    const value = productContentBlockDefault(type);
    const onChange = vi.fn();
    act(() => root.render(<BlockSettingsEditor type={type} settings={value.settings as Record<string, unknown>} media={new Map()} onMediaChosen={vi.fn()} onChange={onChange} disabled />));
    expect(host.querySelector("input, textarea, button, [contenteditable=true], [role=combobox]")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("replaces an active rich-text editor with sanitized, fully readable saved HTML", () => {
    const settings = { title: "Care instructions", html: '<p>Keep dry. <strong>Hand wash only.</strong></p><script>alert(1)</script>' };
    const onChange = vi.fn();
    const props = { type: "rich-text" as const, settings, media: new Map(), onMediaChosen: vi.fn(), onChange };
    act(() => root.render(<BlockSettingsEditor {...props} />));
    expect(host.querySelector("[data-editor]")).not.toBeNull();
    act(() => root.render(<BlockSettingsEditor {...props} disabled />));
    expect(host.querySelector("[data-editor], script, textarea, input")).toBeNull();
    expect(host.textContent).toContain("Hand wash only.");
    expect(host.querySelector("strong")?.textContent).toBe("Hand wash only.");
    expect(onChange).not.toHaveBeenCalled();
  });
});
