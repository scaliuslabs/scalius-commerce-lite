// @vitest-environment happy-dom

import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DeferredTiptapEditor } from "./DeferredTiptapEditor";

vi.mock("~/components/admin/media-manager", () => ({
  MediaManager: () => null,
}));

vi.mock("@scalius/shared/image-optimizer", () => ({
  getOptimizedImageUrl: (url: string) => url,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("DeferredTiptapEditor", () => {
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

  it("mounts the editable canvas through the StrictMode effect replay", async () => {
    await act(async () => {
      root.render(
        <StrictMode>
          <DeferredTiptapEditor
            content="<p>Editable content</p>"
            onChange={vi.fn()}
            ariaLabel="Strict mode content"
          />
        </StrictMode>,
      );
    });

    await vi.waitFor(() => {
      expect(
        host.querySelector('[contenteditable="true"][aria-label="Strict mode content"]'),
      ).not.toBeNull();
    });
    expect(host.querySelector(".ProseMirror")).not.toBeNull();
  });
});
