// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { SlideRow } from "./SlideRow";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("./HeroFocalPointEditor", () => ({ HeroFocalPointEditor: () => null }));
vi.mock("./NavigationResourcePicker", () => ({ NavigationResourcePicker: () => null }));

it("edits the supporting text separately from image alt text and heading", () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onChange = vi.fn();
  act(() => root.render(<SlideRow
    slide={{ id: "slide-1", url: "https://cdn.test/banner.jpg", title: "Photo of a bag", heading: "New arrivals", supportingText: "Free delivery today", buttonLabel: "Shop now", link: "/sale", focalPoint: { x: 50, y: 50 } }}
    index={0}
    viewport="desktop"
    sortable={{ dragHandleProps: {}, isDragging: false, ref: () => {}, style: undefined }}
    onChange={onChange}
    onRemove={() => {}}
  />));
  const input = container.querySelector<HTMLInputElement>("#banner-supporting-text-slide-1")!;
  expect(input.value).toBe("Free delivery today");
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "Across the store");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(onChange).toHaveBeenCalledWith({ supportingText: "Across the store" });
  act(() => root.unmount());
  container.remove();
});
