// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ToolbarButton } from "./ToolbarButton";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("ToolbarButton", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
  });

  it("forwards the click event to cloned trigger handlers", () => {
    const onClick = vi.fn();

    act(() => {
      root.render(
        <ToolbarButton
          onClick={onClick}
          tooltip="Media Library"
          buttonSize="h-7 w-7"
        >
          <span>Open</span>
        </ToolbarButton>,
      );
    });

    const button = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Media Library"]',
    );
    if (!button) throw new Error("Expected toolbar button");

    act(() => {
      button.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onClick.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        defaultPrevented: false,
        type: "click",
      }),
    );
  });
});
