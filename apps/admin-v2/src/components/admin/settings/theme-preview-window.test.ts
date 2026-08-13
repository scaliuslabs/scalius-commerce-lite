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

  it("opens only a secret-free blank placeholder synchronously", () => {
    const previewWindow = { focus: vi.fn() } as unknown as Window;
    const open = vi.spyOn(window, "open").mockReturnValue(previewWindow);
    expect(prepareThemePreviewWindow({
      storefrontUrl: "https://storefront.example.test",
    })).toBe(previewWindow);
    expect(open).toHaveBeenCalledWith(
      "about:blank",
      expect.stringMatching(/^scalius-theme-preview-/),
    );
  });

  it("hands the one-time code to the exact storefront relay through window memory", async () => {
    const replace = vi.fn();
    const previewWindow = {
      name: "scalius-theme-preview-test",
      location: { replace },
    } as unknown as Window;

    await expect(submitThemePreview({
      previewWindow,
      storefrontUrl: "https://storefront.example.test",
      continuation: CONTINUATION,
    })).resolves.toBeUndefined();
    expect(replace).toHaveBeenCalledWith(CONTINUATION.url);
    expect(previewWindow.name).toMatch(/^scalius-continuation-v1:[A-Za-z0-9_-]+$/);
    expect(previewWindow.name).not.toContain(CODE);
    const encoded = previewWindow.name.split(":", 2)[1]!;
    expect(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))).toEqual(
      CONTINUATION.fields,
    );
  });

  it("rejects URL-carried, off-origin, and malformed continuation codes", async () => {
    for (const continuation of [
      { ...CONTINUATION, url: `${CONTINUATION.url}/${CODE}` },
      { ...CONTINUATION, url: "https://evil.example.test/theme-preview/continue" },
      { ...CONTINUATION, fields: { ...CONTINUATION.fields, continuationCode: "bad" } },
    ]) {
      await expect(submitThemePreview({
        previewWindow: { name: "scalius-theme-preview-test" } as Window,
        storefrontUrl: "https://storefront.example.test",
        continuation,
      })).rejects.toThrow("Invalid storefront preview destination");
    }
  });
});
