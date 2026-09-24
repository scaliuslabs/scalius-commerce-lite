// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MediaUploadQueue } from "./MediaUploadQueue";
import type { UploadQueueItem } from "../types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function queueItem(id: string, update: Partial<UploadQueueItem>): UploadQueueItem {
  return {
    id,
    file: new File(["asset"], `${id}.jpg`, { type: "image/jpeg" }),
    kind: "image",
    status: "uploading",
    progress: 40,
    sessionId: null,
    error: null,
    warning: null,
    result: null,
    ...update,
  };
}

describe("MediaUploadQueue", () => {
  let host: HTMLDivElement;
  let root: Root;
  const onRetry = vi.fn();
  const onDismiss = vi.fn();

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    onRetry.mockReset();
    onDismiss.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const render = (queue: UploadQueueItem[]) =>
    act(() => root.render(<MediaUploadQueue queue={queue} onRetry={onRetry} onDismiss={onDismiss} />));
  const text = () => host.textContent?.replace(/\s+/g, " ").trim() ?? "";
  const button = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

  it("renders nothing once every row has left", () => {
    render([]);
    expect(host.innerHTML).toBe("");
  });

  it("shows real progress and asks to keep the tab open only while something is in flight", () => {
    render([queueItem("cyan", { progress: 40 })]);
    expect(text()).toContain("Uploading 40%");
    expect(text()).toContain("Keep this tab open");

    render([queueItem("cyan", { status: "done", progress: 100 })]);
    expect(text()).toContain("Uploaded");
    expect(text()).not.toContain("Keep this tab open");
    expect(host.querySelector('[role="progressbar"]')).toBeNull();
  });

  it("gives a rejected file a plain reason and a Remove action, but no Retry", () => {
    render([queueItem("fake", { status: "failed", kind: null, error: "notImage" })]);
    expect(text()).toContain("Not a supported image");
    expect(text()).not.toContain("Keep this tab open");
    expect(button("Retry fake.jpg")).toBeNull();
    act(() => button("Remove fake.jpg from uploads")!.click());
    expect(onDismiss).toHaveBeenCalledWith("fake");
  });

  it("offers Retry for a failed upload", () => {
    render([queueItem("net", { status: "failed", error: "failed" })]);
    expect(text()).toContain("Upload failed");
    act(() => button("Retry net.jpg")!.click());
    expect(onRetry).toHaveBeenCalledWith("net");
  });

  it("announces each state with singular grammar", () => {
    render([
      queueItem("active", {}),
      queueItem("done", { status: "done" }),
      queueItem("failed", { status: "failed", error: "failed" }),
    ]);
    const announcement = host.querySelector('[aria-live="polite"]')?.textContent?.replace(/\s+/g, " ").trim();
    expect(announcement).toBe("1 upload in progress. 1 upload ready. 1 upload needs attention.");
  });
});
