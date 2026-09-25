import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  complete: vi.fn(),
  getUpload: vi.fn(),
  startUpload: vi.fn(),
}));
vi.mock("@scalius/api-client/sdk", () => ({
  postApiV1AdminDigitalAssetsByIdUploadsByUploadIdComplete: sdk.complete,
  getApiV1AdminDigitalAssetsByIdUploadsByUploadId: sdk.getUpload,
  postApiV1AdminDigitalAssetsByIdUploads: sdk.startUpload,
}));
vi.mock("~/lib/api", () => ({ apiData: (value: unknown) => Promise.resolve(value) }));

import { formatBytes, partRange, resumeOrRestart, sendDigitalFile } from "./digital-upload";

const session = (uploadedParts: number[] = []) => ({ id: "upl_1", assetId: "dga_1", partSize: 4, partCount: 3, sizeBytes: 10, uploadedParts });
const ok = () => new Response(JSON.stringify({ success: true, data: { partNumber: 1, size: 4 } }), { status: 200 });

describe("digital file upload", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    sdk.complete.mockResolvedValue({ asset: { id: "dga_1", status: "ready" } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("cuts exact parts: every part but the last is partSize", () => {
    expect([1, 2, 3].map((part) => partRange(session(), part))).toEqual([
      { start: 0, end: 4 }, { start: 4, end: 8 }, { start: 8, end: 10 },
    ]);
  });

  it("sends the missing parts in order as raw bytes, reports progress, then completes", async () => {
    fetchMock.mockImplementation(async () => ok());
    const progress: number[] = [];
    const asset = await sendDigitalFile({
      assetId: "dga_1",
      session: session([2]),
      file: new Blob(["0123456789"]),
      signal: new AbortController().signal,
      onProgress: (sent) => progress.push(sent),
    });
    expect(fetchMock.mock.calls.map(([url]) => String(url).replace(/^.*digital-assets/, ""))).toEqual([
      "/dga_1/uploads/upl_1/parts/1",
      "/dga_1/uploads/upl_1/parts/3",
    ]);
    const [, init] = fetchMock.mock.calls[1]!;
    expect(init).toMatchObject({ method: "PUT", headers: { "content-type": "application/octet-stream" } });
    expect(await (init.body as Blob).text()).toBe("89");
    expect(progress).toEqual([4, 8, 10]);
    expect(sdk.complete).toHaveBeenCalledWith({ path: { id: "dga_1", uploadId: "upl_1" } });
    expect(asset).toMatchObject({ status: "ready" });
  });

  it("stops on a refused part with the server's reason and never completes", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ success: false, error: { code: "VALIDATION_ERROR", message: "Part 1 must be exactly 4 bytes." } }), { status: 400 }));
    await expect(sendDigitalFile({
      assetId: "dga_1", session: session(), file: new Blob(["0123456789"]), signal: new AbortController().signal, onProgress: () => {},
    })).rejects.toMatchObject({ status: 400, message: "Part 1 must be exactly 4 bytes." });
    expect(sdk.complete).not.toHaveBeenCalled();
  });

  it("resumes the same upload while it is open, else starts a new one", async () => {
    const file = new File(["0123456789"], "book.pdf", { type: "application/pdf" });
    sdk.getUpload.mockResolvedValueOnce({ upload: { ...session([1]), status: "uploading" } });
    await expect(resumeOrRestart("dga_1", "upl_1", file)).resolves.toMatchObject({ id: "upl_1", uploadedParts: [1] });
    expect(sdk.startUpload).not.toHaveBeenCalled();

    sdk.getUpload.mockResolvedValueOnce({ upload: { ...session(), status: "aborted" } });
    sdk.startUpload.mockResolvedValueOnce({ upload: { ...session(), id: "upl_2" } });
    await expect(resumeOrRestart("dga_1", "upl_1", file)).resolves.toMatchObject({ id: "upl_2" });
    expect(sdk.startUpload).toHaveBeenCalledWith({
      path: { id: "dga_1" },
      body: { filename: "book.pdf", mediaType: "application/pdf", sizeBytes: 10 },
    });
  });

  it("formats sizes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(50 * 1024 * 1024)).toBe("50 MB");
  });
});
