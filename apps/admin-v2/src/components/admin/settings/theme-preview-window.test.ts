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

  it("posts the one-time code directly to the exact storefront continuation", async () => {
    const previewDocument = document;
    const submit = vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(() => {});
    const previewWindow = {
      name: "scalius-theme-preview-test",
      document: previewDocument,
    } as unknown as Window;

    await expect(submitThemePreview({
      previewWindow,
      storefrontUrl: "https://storefront.example.test",
      continuation: CONTINUATION,
    })).resolves.toBeUndefined();
    expect(submit).toHaveBeenCalledOnce();
    const form = previewDocument.querySelector("form");
    expect(form?.method.toLowerCase()).toBe("post");
    expect(form?.action).toBe(CONTINUATION.url);
    expect(Object.fromEntries(
      [...previewDocument.querySelectorAll("input")].map((input) => [input.name, input.value]),
    )).toEqual(CONTINUATION.fields);
  });

  it("rejects URL-carried, off-origin, and malformed continuation codes", async () => {
    for (const continuation of [
      { ...CONTINUATION, url: `${CONTINUATION.url}/${CODE}` },
      { ...CONTINUATION, url: "https://evil.example.test/theme-preview/continue" },
      { ...CONTINUATION, fields: { ...CONTINUATION.fields, continuationCode: "bad" } },
    ]) {
      await expect(submitThemePreview({
        previewWindow: { document } as unknown as Window,
        storefrontUrl: "https://storefront.example.test",
        continuation,
      })).rejects.toThrow("Invalid storefront preview destination");
    }
  });
});
