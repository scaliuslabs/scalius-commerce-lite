// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMediaUpload } from "./useMediaUpload";
import type { MediaUploadSession } from "../api";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
  initiateUpload: vi.fn(),
  getUpload: vi.fn(),
  uploadPart: vi.fn(),
  completeUpload: vi.fn(),
  abortUpload: vi.fn(),
}));

vi.mock("../api", () => ({ MediaApiClient: api }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

type HookValue = ReturnType<typeof useMediaUpload>;
let latest: HookValue;

function Harness() {
  latest = useMediaUpload({ capability: "both", folderId: null });
  return null;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function flush() {
  for (let index = 0; index < 4; index += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

describe("useMediaUpload initiation races", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    Object.values(api).forEach((mock) => mock.mockReset());
    api.abortUpload.mockResolvedValue(undefined);
    act(() => root.render(<Harness />));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("aborts a server session created after the merchant cancelled initiation", async () => {
    const initiation = deferred<MediaUploadSession>();
    api.initiateUpload.mockReturnValue(initiation.promise);

    const image = new File([new Uint8Array([1])], "photo.png", { type: "image/png" });
    await act(async () => { await latest.uploadFiles([image]); });
    expect(latest.queue[0]?.status).toBe("initiating");
    act(() => latest.cancel(latest.queue[0]!.id));

    initiation.resolve({
      id: "upload_session_1", mediaId: "media_1", filename: "photo.png", kind: "image",
      mimeType: "image/png", size: 1, expectedParts: 1, partSize: 5 * 1024 * 1024,
      state: "initiated", version: 1, expiresAt: Date.now() + 60_000, uploadedParts: [],
    });
    await flush();

    expect(api.abortUpload).toHaveBeenCalledWith("upload_session_1");
    expect(api.uploadPart).not.toHaveBeenCalled();
    expect(latest.queue[0]?.status).toBe("cancelled");
  });

  it("keeps a newly created session paused instead of reviving the upload", async () => {
    const initiation = deferred<MediaUploadSession>();
    api.initiateUpload.mockReturnValue(initiation.promise);
    const image = new File([new Uint8Array([1])], "photo.png", { type: "image/png" });
    await act(async () => { await latest.uploadFiles([image]); });
    act(() => latest.pause(latest.queue[0]!.id));
    initiation.resolve({ id: "upload_session_2", mediaId: "media_2", filename: "photo.png", kind: "image", mimeType: "image/png", size: 1, expectedParts: 1, partSize: 5 * 1024 * 1024, state: "initiated", version: 1, expiresAt: Date.now() + 60_000, uploadedParts: [] });
    await flush();
    expect(api.uploadPart).not.toHaveBeenCalled();
    expect(latest.queue[0]).toMatchObject({ status: "paused", sessionId: "upload_session_2" });
  });
});
