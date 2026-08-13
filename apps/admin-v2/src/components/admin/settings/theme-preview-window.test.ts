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

  it("posts the one-time code in a form body to the exact storefront window", async () => {
    let submitted: {
      action: string;
      method: string;
      target: string;
      fields: Record<string, string>;
    } | null = null;
    const submit = vi.spyOn(HTMLFormElement.prototype, "submit")
      .mockImplementation(function capture(this: HTMLFormElement) {
        submitted = {
          action: this.action,
          method: this.method,
          target: this.target,
          fields: Object.fromEntries(
            [...this.querySelectorAll<HTMLInputElement>("input")]
              .map((input) => [input.name, input.value]),
          ),
        };
      });

    await expect(submitThemePreview({
      previewWindow: { name: "scalius-theme-preview-test" } as Window,
      storefrontUrl: "https://storefront.example.test",
      continuation: CONTINUATION,
    })).resolves.toBeUndefined();
    expect(submit).toHaveBeenCalledOnce();
    expect(submitted).toEqual({
      action: CONTINUATION.url,
      method: "post",
      target: "scalius-theme-preview-test",
      fields: { continuationCode: CODE, path: "/", device: "full" },
    });
    expect(document.body.querySelector("form")).toBeNull();
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
