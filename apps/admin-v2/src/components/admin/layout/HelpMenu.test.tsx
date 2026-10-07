// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import HelpMenu from "./HelpMenu";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("help menu", () => {
  let host: HTMLDivElement;
  let root: Root;

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("offers where to ask, where to report, and the keyboard shortcuts", async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const onShortcuts = vi.fn();
    await act(async () => root.render(
      <HelpMenu open onOpenChange={() => {}} trigger={<button type="button">Help</button>} onShortcuts={onShortcuts} />,
    ));
    const items = Array.from(document.querySelectorAll('[role="menuitem"]'));
    expect(items.map((item) => item.textContent)).toEqual(["Ask a question", "Report a problem", "Keyboard shortcuts"]);
    expect(items[0]?.getAttribute("href")).toBe("https://scalius.com/discord");
    expect(items[1]?.getAttribute("rel")).toBe("noopener noreferrer");
    await act(async () => (items[2] as HTMLElement).click());
    expect(onShortcuts).toHaveBeenCalledOnce();
  });
});
