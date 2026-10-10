// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ModalInertBackground } from "./overlay";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("makes Radix-hidden branches inert, preserves existing state, and survives overlapping portals", async () => {
  const host = document.createElement("div");
  const background = document.createElement("div");
  const alreadyInert = document.createElement("div");
  alreadyInert.inert = true;
  background.setAttribute("data-aria-hidden", "true");
  alreadyInert.setAttribute("data-aria-hidden", "true");
  document.body.append(host, background, alreadyInert);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<><ModalInertBackground key="first" /><ModalInertBackground key="second" /></>));
    expect(background.inert).toBe(true);
    await act(async () => root.render(<ModalInertBackground key="second" />));
    expect(background.inert).toBe(true);
    background.removeAttribute("data-aria-hidden");
    await vi.waitFor(() => expect(background.inert).not.toBe(true));
    expect(alreadyInert.inert).toBe(true);
    background.setAttribute("data-aria-hidden", "true");
    await vi.waitFor(() => expect(background.inert).toBe(true));
    await act(async () => root.render(null));
    expect(background.inert).not.toBe(true);
    expect(alreadyInert.inert).toBe(true);
  } finally {
    act(() => root.unmount());
    host.remove();
    background.remove();
    alreadyInert.remove();
  }
});
