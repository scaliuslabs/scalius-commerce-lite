// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MediaUploadQueue } from "./MediaUploadQueue";
import type { UploadQueueItem } from "../types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function queueItem(status: UploadQueueItem["status"], id: string): UploadQueueItem {
  return {
    id,
    file: new File(["asset"], `${id}.png`, { type: "image/png" }),
    kind: "image",
    status,
    progress: status === "complete" ? 100 : 50,
    uploadedParts: [],
    expectedParts: 1,
    sessionId: null,
    failedPart: null,
    error: status === "failed" ? "Try again" : null,
    warning: null,
    result: null,
  };
}

describe("MediaUploadQueue announcements", () => {
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

  it("uses singular upload grammar for every queue state", () => {
    act(() => root.render(
      <MediaUploadQueue
        queue={[
          queueItem("uploading", "active"),
          queueItem("complete", "complete"),
          queueItem("failed", "failed"),
        ]}
        onPause={vi.fn()}
        onResume={vi.fn()}
        onCancel={vi.fn()}
        onClearFinished={vi.fn()}
      />,
    ));

    const announcement = host.querySelector('[aria-live="polite"]')?.textContent?.replace(/\s+/g, " ").trim();
    expect(announcement).toBe("1 upload in progress. 1 upload ready. 1 upload needs attention.");
  });
});
