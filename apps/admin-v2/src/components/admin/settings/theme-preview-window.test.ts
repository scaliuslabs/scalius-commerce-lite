// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  THEME_PREVIEW_HANDOFF_ACCEPTED,
  THEME_PREVIEW_HANDOFF_READY,
  THEME_PREVIEW_HANDOFF_TOKEN,
} from "@scalius/shared/theme-preview-handoff";

import { submitThemePreview } from "./theme-preview-window";

const TOKEN = `tpv_${"a".repeat(48)}`;

describe("theme preview window handshake", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends the bearer only to the exact storefront window and origin", async () => {
    const previewWindow = { postMessage: vi.fn() } as unknown as Window;
    const promise = submitThemePreview({
      previewWindow,
      storefrontUrl: "https://storefront.example.test",
      token: TOKEN,
      timeoutMs: 1_000,
    });

    window.dispatchEvent(new MessageEvent("message", {
      origin: "https://evil.example.test",
      source: previewWindow,
      data: { type: THEME_PREVIEW_HANDOFF_READY },
    }));
    expect(previewWindow.postMessage).not.toHaveBeenCalled();

    window.dispatchEvent(new MessageEvent("message", {
      origin: "https://storefront.example.test",
      source: previewWindow,
      data: { type: THEME_PREVIEW_HANDOFF_READY },
    }));
    expect(previewWindow.postMessage).toHaveBeenCalledWith(
      { type: THEME_PREVIEW_HANDOFF_TOKEN, token: TOKEN },
      "https://storefront.example.test",
    );

    window.dispatchEvent(new MessageEvent("message", {
      origin: "https://storefront.example.test",
      source: previewWindow,
      data: { type: THEME_PREVIEW_HANDOFF_ACCEPTED },
    }));
    await expect(promise).resolves.toBeUndefined();
  });

  it("rejects malformed tokens before opening a message channel", async () => {
    await expect(submitThemePreview({
      previewWindow: { postMessage: vi.fn() } as unknown as Window,
      storefrontUrl: "https://storefront.example.test",
      token: "bad",
    })).rejects.toThrow("Invalid storefront preview token");
  });
});
