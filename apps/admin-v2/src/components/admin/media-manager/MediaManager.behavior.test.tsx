// @vitest-environment happy-dom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MediaManager } from "./MediaManager";
import { MediaManager as LazyMediaManager } from "./LazyMediaManager";
import { Dialog } from "~/components/ui/dialog";
import type { MediaFile } from "./types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const pickerState = vi.hoisted(() => ({
  onSelect: undefined as ((file: MediaFile) => void) | undefined,
}));

vi.mock("./hooks/useMediaManager", () => ({
  useMediaManager: (options: { onSelect?: (file: MediaFile) => void }) => {
    pickerState.onSelect = options.onSelect;
    return {
      currentFolderId: "all",
      load: vi.fn().mockResolvedValue(undefined),
      loadFolders: vi.fn().mockResolvedValue(undefined),
      replaceSelection: vi.fn(),
      setSelectionMode: vi.fn(),
    };
  },
}));

vi.mock("./MediaWorkspace", () => ({
  MediaWorkspace: ({ onClose }: { onClose?: () => void }) => (
    <div>
      <button
        type="button"
        onClick={() => pickerState.onSelect?.({
          id: "media_1",
          url: "https://cdn.example.com/image.webp",
          filename: "image.webp",
          mimeType: "image/webp",
          size: 100,
          createdAt: new Date("2026-07-19T00:00:00.000Z"),
        })}
      >
        Choose test image
      </button>
      <button type="button" onClick={onClose}>Close workspace</button>
    </div>
  ),
}));

async function flush() {
  for (let index = 0; index < 3; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function click(element: Element) {
  element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

describe("MediaManager lazy-open lifecycle", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    pickerState.onSelect = undefined;
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  it("closes after a single selection and remains dismissible on later opens", async () => {
    const onSelect = vi.fn();
    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <Dialog open={open} onOpenChange={setOpen}>
          <button type="button" onClick={() => setOpen(true)}>Select image</button>
          <MediaManager
            capability="image"
            onSelect={onSelect}
            open={open}
            onOpenChange={setOpen}
          />
        </Dialog>
      );
    }

    await act(async () => {
      root.render(<Harness />);
    });
    await flush();

    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    const choose = Array.from(document.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Choose test image"),
    );
    expect(choose).toBeDefined();
    act(() => click(choose!));
    await flush();

    expect(onSelect).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    const trigger = Array.from(host.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Select image"),
    );
    expect(trigger).toBeDefined();
    act(() => click(trigger!));
    await flush();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    const close = Array.from(document.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Close workspace"),
    );
    act(() => click(close!));
    await flush();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("closes the lazy picker when its caller rerenders with the chosen file", async () => {
    function Harness() {
      const [filename, setFilename] = useState("none");
      return (
        <>
          <span data-selected-file>{filename}</span>
          <LazyMediaManager
            capability="image"
            onSelect={(file) => setFilename(file.filename)}
          />
        </>
      );
    }

    await act(async () => root.render(<Harness />));
    const trigger = Array.from(host.querySelectorAll("button")).find((button) =>
      button.textContent?.toLowerCase().includes("choose image"),
    );
    expect(trigger).toBeDefined();
    expect(trigger?.className).toContain("min-h-11");
    act(() => click(trigger!));
    await flush();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    const choose = Array.from(document.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Choose test image"),
    );
    expect(choose).toBeDefined();
    act(() => click(choose!));
    await flush();

    expect(host.querySelector("[data-selected-file]")?.textContent).toBe("image.webp");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
