// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  prepareThemePreviewWindow,
  submitThemePreview,
} from "./theme-preview-window";

const CODE = `tpc_${"a".repeat(48)}`;
const CONTINUATION = {
  url: "https://storefront.example.test/theme-preview/continue",
  method: "POST" as const,
  fields: { continuationCode: CODE, path: "/", device: "full" as const },
};

describe("theme preview continuation window", () => {
  afterEach(() => vi.restoreAllMocks());

  it("opens only the secret-free storefront relay synchronously", () => {
    const previewWindow = { focus: vi.fn(), postMessage: vi.fn() } as unknown as Window;
    const open = vi.spyOn(window, "open").mockReturnValue(previewWindow);
    expect(prepareThemePreviewWindow({
      storefrontUrl: "https://storefront.example.test",
    })).toBe(previewWindow);
    expect(open).toHaveBeenCalledWith(
      "https://storefront.example.test/theme-preview/continue",
      expect.stringMatching(/^scalius-theme-preview-/),
    );
  });

  it("hands the one-time code to the exact-origin storefront opener relay", async () => {
    const postMessage = vi.fn();
    const previewWindow = {
      focus: vi.fn(),
      postMessage,
    } as unknown as Window;
    vi.spyOn(window, "open").mockReturnValue(previewWindow);
    expect(prepareThemePreviewWindow({
      storefrontUrl: "https://storefront.example.test",
    })).toBe(previewWindow);

    const submitted = submitThemePreview({
      previewWindow,
      storefrontUrl: "https://storefront.example.test",
      continuation: CONTINUATION,
    });
    window.dispatchEvent(new MessageEvent("message", {
      origin: "https://storefront.example.test",
      source: previewWindow as WindowProxy,
      data: { type: "scalius-continuation-ready-v1" },
    }));
    expect(postMessage).toHaveBeenCalledWith({
      type: "scalius-continuation-fields-v1",
      fields: CONTINUATION.fields,
    }, "https://storefront.example.test");
    window.dispatchEvent(new MessageEvent("message", {
      origin: "https://storefront.example.test",
      source: previewWindow as WindowProxy,
      data: { type: "scalius-continuation-accepted-v1" },
    }));
    await expect(submitted).resolves.toBeUndefined();
  });

  it("rejects URL-carried, off-origin, and malformed continuation codes", async () => {
    for (const continuation of [
      { ...CONTINUATION, url: `${CONTINUATION.url}/${CODE}` },
      { ...CONTINUATION, url: "https://evil.example.test/theme-preview/continue" },
      { ...CONTINUATION, fields: { ...CONTINUATION.fields, continuationCode: "bad" } },
    ]) {
      await expect(submitThemePreview({
        previewWindow: { postMessage: vi.fn() } as unknown as Window,
        storefrontUrl: "https://storefront.example.test",
        continuation,
      })).rejects.toThrow("Invalid storefront preview destination");
    }
  });
});
