// @vitest-environment happy-dom

import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminApiResponseError } from "~/lib/admin-api-error";
import { DONE_ROW_MS, useMediaUpload } from "./useMediaUpload";
import type { MediaUploadSession } from "../api";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
  initiateUpload: vi.fn(),
  getUpload: vi.fn(),
  uploadPart: vi.fn(),
  completeUpload: vi.fn(),
  abortUpload: vi.fn(),
  updateFile: vi.fn(),
  saveVariants: vi.fn(),
}));

const metadata = vi.hoisted(() => ({
  readIntrinsicMediaMetadata: vi.fn(),
}));

vi.mock("../api", () => ({ MediaApiClient: api }));
vi.mock("../utils/intrinsic-metadata", () => metadata);
const encoder = vi.hoisted(() => ({
  canEncodeMediaVariants: (mimeType: string) => mimeType !== "image/gif" && mimeType.startsWith("image/"),
  encodeMediaVariants: vi.fn(),
}));
vi.mock("../utils/media-variants", () => encoder);
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

type HookValue = ReturnType<typeof useMediaUpload>;
let latest: HookValue;
const onUploadComplete = vi.fn();

function Harness() {
  latest = useMediaUpload({ capability: "both", folderId: null, onUploadComplete });
  return null;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function flush() {
  for (let index = 0; index < 6; index += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

const JPEG = [0xff, 0xd8, 0xff, 0xe0];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const MP4 = [0, 0, 0, 16, ...[..."ftypisom"].map((c) => c.charCodeAt(0)), 0, 0, 0, 0];

function fileOf(signature: number[], name: string, type: string, size = 16) {
  const bytes = new Uint8Array(Math.max(size, signature.length));
  bytes.set(signature);
  return new File([bytes], name, { type });
}

function session(id: string, overrides: Partial<MediaUploadSession> = {}): MediaUploadSession {
  return {
    id, mediaId: `media_${id}`, filename: "photo.jpg", kind: "image", mimeType: "image/jpeg", size: 16,
    expectedParts: 1, partSize: 5 * 1024 * 1024, state: "initiated", version: 1,
    expiresAt: Date.now() + 60_000, uploadedParts: [], ...overrides,
  } as MediaUploadSession;
}

function uploaded(id: string) {
  return { id, version: 1, width: 10, height: 10 };
}

describe("useMediaUpload", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    Object.values(api).forEach((mock) => mock.mockReset());
    onUploadComplete.mockReset();
    api.abortUpload.mockResolvedValue(undefined);
    metadata.readIntrinsicMediaMetadata.mockReset().mockResolvedValue(null);
    encoder.encodeMediaVariants.mockReset().mockResolvedValue(null);
    act(() => root.render(<StrictMode><Harness /></StrictMode>));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
  });

  it("moves a row through the real lifecycle under StrictMode, then removes it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const part = deferred<void>();
    api.initiateUpload.mockResolvedValue(session("s1"));
    api.uploadPart.mockReturnValue(part.promise);
    api.completeUpload.mockResolvedValue(uploaded("media_s1"));

    await act(async () => { await latest.uploadFiles([fileOf(JPEG, "cyan.jpg", "image/jpeg")]); });
    await flush();
    expect(latest.queue[0]).toMatchObject({ status: "uploading", progress: 0 });
    expect(latest.isUploading).toBe(true);

    part.resolve();
    await flush();
    expect(latest.queue[0]).toMatchObject({ status: "done", progress: 100, error: null });
    expect(latest.isUploading).toBe(false);
    expect(onUploadComplete).toHaveBeenCalledWith([uploaded("media_s1")]);

    await act(async () => { await vi.advanceTimersByTimeAsync(DONE_ROW_MS); });
    expect(latest.queue).toEqual([]);
  });

  it("rejects a text file named .jpg before uploading anything", async () => {
    const fake = new File(["just some text, not an image"], "fake.jpg", { type: "image/jpeg" });
    await act(async () => { await latest.uploadFiles([fake]); });
    await flush();

    expect(api.initiateUpload).not.toHaveBeenCalled();
    expect(latest.queue[0]).toMatchObject({ status: "failed", error: "notMedia" });
    expect(latest.isUploading).toBe(false);

    act(() => latest.dismiss(latest.queue[0]!.id));
    expect(latest.queue).toEqual([]);
  });

  it("rejects files over the size limit with the size reason", async () => {
    const big = fileOf(PNG, "huge.png", "image/png");
    Object.defineProperty(big, "size", { value: 21 * 1024 * 1024 });
    await act(async () => { await latest.uploadFiles([big]); });
    expect(latest.queue[0]).toMatchObject({ status: "failed", error: "imageTooLarge" });
    expect(api.initiateUpload).not.toHaveBeenCalled();
  });

  it("maps a server rejection to plain copy, never the server's text", async () => {
    api.initiateUpload.mockRejectedValue(new AdminApiResponseError("File content is text/plain", 400, "VALIDATION_ERROR"));
    await act(async () => { await latest.uploadFiles([fileOf(PNG, "photo.png", "image/png")]); });
    await flush();
    expect(latest.queue[0]).toMatchObject({ status: "failed", error: "notMedia" });
  });

  it("retries a dropped connection from the part the server already has", async () => {
    const twoParts = 5 * 1024 * 1024 + 16;
    const big = fileOf(JPEG, "large.jpg", "image/jpeg", twoParts);
    api.initiateUpload.mockResolvedValue(session("s2", { expectedParts: 2, size: twoParts }));
    api.uploadPart.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await act(async () => { await latest.uploadFiles([big]); });
    await flush();
    expect(latest.queue[0]).toMatchObject({ status: "failed", error: "failed", sessionId: "s2" });

    api.getUpload.mockResolvedValue(session("s2", {
      expectedParts: 2, size: twoParts, state: "uploading",
      uploadedParts: [{ partNumber: 1, size: 5 * 1024 * 1024 }] as MediaUploadSession["uploadedParts"],
    }));
    api.uploadPart.mockResolvedValue(undefined);
    api.completeUpload.mockResolvedValue(uploaded("media_s2"));
    act(() => latest.retry(latest.queue[0]!.id));
    await flush();

    expect(api.initiateUpload).toHaveBeenCalledTimes(1);
    expect(api.uploadPart).toHaveBeenLastCalledWith("s2", 2, expect.any(Blob), expect.any(AbortSignal));
    expect(latest.queue[0]).toMatchObject({ status: "done", error: null });
  });

  it("aborts a server session created after the merchant removed the row", async () => {
    const initiation = deferred<MediaUploadSession>();
    api.initiateUpload.mockReturnValue(initiation.promise);

    await act(async () => { await latest.uploadFiles([fileOf(PNG, "photo.png", "image/png")]); });
    await flush();
    expect(latest.queue[0]?.status).toBe("uploading");
    const whileUploading = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(whileUploading);
    expect(whileUploading.defaultPrevented).toBe(true);

    act(() => latest.dismiss(latest.queue[0]!.id));
    initiation.resolve(session("s3"));
    await flush();

    expect(api.abortUpload).toHaveBeenCalledWith("s3");
    expect(api.uploadPart).not.toHaveBeenCalled();
    expect(latest.queue).toEqual([]);
    const afterRemove = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(afterRemove);
    expect(afterRemove.defaultPrevented).toBe(false);
  });

  it("persists intrinsic video dimensions and duration after completion", async () => {
    metadata.readIntrinsicMediaMetadata.mockResolvedValue({ width: 1920, height: 1080, durationMs: 23_567 });
    api.initiateUpload.mockResolvedValue(session("s4", { kind: "video", mimeType: "video/mp4" }));
    api.uploadPart.mockResolvedValue(undefined);
    const completed = { id: "media_s4", width: null, height: null, version: 1 };
    api.completeUpload.mockResolvedValue(completed);
    api.updateFile.mockImplementation(async (file, updates) => ({ ...file, ...updates, version: 2 }));

    await act(async () => { await latest.uploadFiles([fileOf(MP4, "walkthrough.mp4", "video/mp4")]); });
    await flush();

    expect(api.completeUpload).toHaveBeenCalledWith("s4", "server");
    expect(encoder.encodeMediaVariants).not.toHaveBeenCalled();
    expect(api.updateFile).toHaveBeenCalledWith(completed, { width: 1920, height: 1080, durationMs: 23_567 });
    expect(latest.queue[0]).toMatchObject({ status: "done", warning: null, result: { width: 1920, version: 2 } });
  });

  it("uploads browser-generated renditions and keeps a row whose renditions failed", async () => {
    const variants = { width: 1200, height: 900, files: new Map([[160, new Blob(["x"], { type: "image/webp" })]]) };
    encoder.encodeMediaVariants.mockResolvedValue(variants);
    api.initiateUpload.mockResolvedValue(session("s5"));
    api.uploadPart.mockResolvedValue(undefined);
    api.completeUpload.mockResolvedValue(uploaded("media_s5"));
    api.saveVariants.mockRejectedValue(new Error("offline"));

    await act(async () => { await latest.uploadFiles([fileOf(JPEG, "photo.jpg", "image/jpeg")]); });
    await flush();

    expect(api.completeUpload).toHaveBeenCalledWith("s5", "client");
    expect(api.saveVariants).toHaveBeenCalledWith("media_s5", variants);
    expect(latest.queue[0]).toMatchObject({ status: "done", warning: "variantsNotSaved" });
  });
});
