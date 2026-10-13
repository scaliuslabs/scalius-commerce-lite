// @vitest-environment happy-dom
import { act, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { FormImageUploadField } from "./FormImageUploadField";
import type { MediaFile } from "../media-manager";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("../media-manager", () => ({
  MediaManager: ({ onSelect }: { onSelect: (file: unknown) => void }) => {
    const [open, setOpen] = useState(false);
    return <><button type="button" onClick={() => setOpen(true)}>Choose image</button>{open ? createPortal(<div role="dialog"><button type="button" onClick={() => onSelect({ id: "changed" })}>Use image</button></div>, document.body) : null}</>;
  },
}));

it("keeps the whole image readable and removes an already-open mutation portal on permission revocation", () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const onChange = vi.fn();
  const image = { id: "portrait", url: "https://images.example/portrait.jpg", filename: "Portrait", altText: "A long portrait", width: 600, height: 1400, size: 1400, createdAt: new Date(0) } satisfies MediaFile;
  try {
    act(() => root.render(<FormImageUploadField value={image} onChange={onChange} />));
    act(() => [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Choose image")!.click());
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    act(() => root.render(<FormImageUploadField value={image} onChange={onChange} readOnly />));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(host.querySelector("button")).toBeNull();
    expect(host.querySelector("img")?.alt).toBe("A long portrait");
    expect(host.querySelector("img")?.classList.contains("object-contain")).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
